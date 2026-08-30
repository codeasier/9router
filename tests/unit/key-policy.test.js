// Per-API-key policy engine — budgets / concurrency / circuit breaker.
// Covers:
//   * policy normalization (valid shapes, clamping, invalid → null)
//   * period window boundaries (day / week / month, UTC)
//   * breaker trip + recovery (fixed duration & until-period-end)
//   * concurrency fast-fail + slot release via response wrapper
//     (done / cancel / error / lease timeout paths)
//   * provider budget check (per-provider + "*" wildcard)
//   * budget cache bump from usage inserts
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the key store so getPolicyForApiKey resolves without a real DB.
let mockKeyRecord = null;
vi.mock("@/lib/localDb", () => ({
  getApiKeyByKey: async () => mockKeyRecord,
}));

let keyPolicy;

beforeEach(async () => {
  vi.resetModules();
  mockKeyRecord = null;
  keyPolicy = await import("@/sse/services/keyPolicy.js");
  keyPolicy._resetKeyPolicyState();
});

const KEY = "sk-test-key-policy";

describe("normalizePolicy", () => {
  it("returns null for empty/invalid input", () => {
    expect(keyPolicy.normalizePolicy(null)).toBeNull();
    expect(keyPolicy.normalizePolicy({})).toBeNull();
    expect(keyPolicy.normalizePolicy({ budgets: [], maxConcurrent: 0 })).toBeNull();
    expect(keyPolicy.normalizePolicy({ budgets: [{ provider: "", limitUsd: 5 }] })).toBeNull();
    expect(keyPolicy.normalizePolicy({ budgets: [{ provider: "codex", limitUsd: -1 }] })).toBeNull();
  });

  it("normalizes valid budgets, clamps concurrency, defaults breaker", () => {
    const p = keyPolicy.normalizePolicy({
      budgets: [{ provider: "codex", limitUsd: "5", period: "day" }, { provider: "cursor", limitUsd: 20, period: "month" }],
      maxConcurrent: 10,
      breaker: { mode: "weird", durationMinutes: 999999 },
    });
    expect(p.budgets).toHaveLength(2);
    expect(p.budgets[0]).toEqual({ provider: "codex", limitUsd: 5, period: "day" });
    expect(p.maxConcurrent).toBe(10);
    expect(p.breaker.mode).toBe("fixed");
    expect(p.breaker.durationMinutes).toBeLessThanOrEqual(24 * 60);
  });

  it("defaults invalid period to day and caps concurrency", () => {
    const p = keyPolicy.normalizePolicy({ budgets: [{ provider: "x", limitUsd: 1, period: "year" }], maxConcurrent: 10000 });
    expect(p.budgets[0].period).toBe("day");
    expect(p.maxConcurrent).toBe(500);
  });
});

describe("periodWindowMs", () => {
  // 2026-08-25 is a Tuesday. UTC week starts Monday 2026-08-24.
  const TUE = Date.UTC(2026, 7, 25, 12, 0, 0);

  it("day window is UTC midnight to midnight", () => {
    const [s, e] = keyPolicy.periodWindowMs("day", TUE);
    expect(s).toBe(Date.UTC(2026, 7, 25));
    expect(e - s).toBe(86400000);
  });

  it("week window starts Monday UTC", () => {
    const [s, e] = keyPolicy.periodWindowMs("week", TUE);
    expect(s).toBe(Date.UTC(2026, 7, 24));
    expect(e - s).toBe(7 * 86400000);
  });

  it("month window is first to first", () => {
    const [s, e] = keyPolicy.periodWindowMs("month", TUE);
    expect(s).toBe(Date.UTC(2026, 7, 1));
    expect(e).toBe(Date.UTC(2026, 8, 1));
  });
});

describe("breaker", () => {
  it("fixed mode: trips for durationMinutes then auto-clears", async () => {
    keyPolicy._setBudgetQuery(async () => 100); // spent $100
    const policy = { budgets: [{ provider: "*", limitUsd: 5, period: "day" }], breaker: { mode: "fixed", durationMinutes: 5 } };

    const now = Date.now();
    const r1 = await keyPolicy.checkBudget(KEY, policy, "codex", now);
    expect(r1.ok).toBe(false);
    expect(r1.status).toBe(429);
    expect(r1.retryAfterMs).toBeGreaterThan(4 * 60_000);

    // Still open before expiry
    const r2 = await keyPolicy.checkBudget(KEY, policy, "codex", now + 60_000);
    expect(r2.ok).toBe(false);

    // After expiry, breaker clears (spent dropped to 0 → pass)
    keyPolicy._setBudgetQuery(async () => 0);
    const r3 = await keyPolicy.checkBudget(KEY, policy, "codex", now + 6 * 60_000);
    expect(r3.ok).toBe(true);
  });

  it("period mode: stays open until period end (day rollover)", async () => {
    keyPolicy._setBudgetQuery(async () => 100);
    const policy = { budgets: [{ provider: "codex", limitUsd: 5, period: "day" }], breaker: { mode: "period" } };

    const now = Date.now();
    const r1 = await keyPolicy.checkBudget(KEY, policy, "codex", now);
    expect(r1.ok).toBe(false);

    const [, endMs] = keyPolicy.periodWindowMs("day", now);
    expect(r1.retryAfterMs).toBe(endMs - now);

    // Provider-scoped: other providers unaffected
    const rOther = await keyPolicy.checkBudget(KEY, policy, "cursor", now + 1000);
    expect(rOther.ok).toBe(true);
  });
});

describe("concurrency", () => {
  it("fast-fails at max, releases on body done", async () => {
    const policy = { maxConcurrent: 2 };

    const g1 = keyPolicy.acquireSlot(KEY, policy);
    const g2 = keyPolicy.acquireSlot(KEY, policy);
    expect(g1.ok && g2.ok).toBe(true);

    const g3 = keyPolicy.acquireSlot(KEY, policy);
    expect(g3.ok).toBe(false);
    expect(g3.status).toBe(429);

    // Wrap a streaming response, consume it fully → slot released
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("hello")); c.close(); },
    });
    const wrapped = keyPolicy.wrapResponseForSlot(new Response(body), KEY);
    await wrapped.arrayBuffer();

    const g4 = keyPolicy.acquireSlot(KEY, policy);
    expect(g4.ok).toBe(true);
  });

  it("releases on cancel and is idempotent", async () => {
    const policy = { maxConcurrent: 1 };
    expect(keyPolicy.acquireSlot(KEY, policy).ok).toBe(true);

    let pullResolve;
    const body = new ReadableStream({
      pull(controller) {
        pullResolve = controller;
        controller.enqueue(new TextEncoder().encode("x"));
      },
    });
    const wrapped = keyPolicy.wrapResponseForSlot(new Response(body), KEY);

    const reader = wrapped.body.getReader();
    await reader.read();
    await reader.cancel("client disconnect");
    await reader.cancel("double cancel"); // idempotent release

    expect(keyPolicy.acquireSlot(KEY, policy).ok).toBe(true);
    expect(pullResolve).toBeTruthy();
  });

  it("releases on stream error", async () => {
    const policy = { maxConcurrent: 1 };
    expect(keyPolicy.acquireSlot(KEY, policy).ok).toBe(true);

    const body = new ReadableStream({
      start(c) { c.error(new Error("boom")); },
    });
    const wrapped = keyPolicy.wrapResponseForSlot(new Response(body), KEY);
    await expect(wrapped.arrayBuffer()).rejects.toBeDefined();

    expect(keyPolicy.acquireSlot(KEY, policy).ok).toBe(true);
  });

  it("releases immediately when response has no body", () => {
    const policy = { maxConcurrent: 1 };
    expect(keyPolicy.acquireSlot(KEY, policy).ok).toBe(true);
    keyPolicy.wrapResponseForSlot(new Response(null, { status: 204 }), KEY);
    expect(keyPolicy.acquireSlot(KEY, policy).ok).toBe(true);
  });

  it("propagates status and headers through wrapper", async () => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("data")); c.close(); },
    });
    const src = new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Custom": "yes" },
    });
    const wrapped = keyPolicy.wrapResponseForSlot(src, KEY);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("x-custom")).toBe("yes");
    await wrapped.arrayBuffer();
  });
});

describe("checkBudget matching", () => {
  it("checks per-provider budget only for matching provider", async () => {
    const spent = { codex: 6, cursor: 0 };
    keyPolicy._setBudgetQuery(async (key, provider) => spent[provider] ?? 0);
    const policy = { budgets: [{ provider: "codex", limitUsd: 5, period: "day" }] };

    expect((await keyPolicy.checkBudget(KEY, policy, "codex")).ok).toBe(false);
    expect((await keyPolicy.checkBudget(KEY, policy, "cursor")).ok).toBe(true);
    expect((await keyPolicy.checkBudget(KEY, policy, null)).ok).toBe(true); // provider unknown → skip specific
  });

  it("wildcard budget applies to any provider", async () => {
    keyPolicy._setBudgetQuery(async () => 10);
    const policy = { budgets: [{ provider: "*", limitUsd: 5, period: "day" }] };
    for (const p of ["codex", "cursor", null]) {
      expect((await keyPolicy.checkBudget(KEY, policy, p)).ok).toBe(false);
    }
  });
});

describe("evaluateProviderBudget", () => {
  it("fails closed for an unpriced attempt only when a budget matches", async () => {
    mockKeyRecord = {
      policy: { budgets: [{ provider: "codex", limitUsd: 5, period: "day" }] },
    };

    const matched = await keyPolicy.evaluateProviderBudget(KEY, "codex", { operation: "image generation" });
    expect(matched.budgetMatched).toBe(true);
    expect(matched.rejectionResponse.status).toBe(403);
    expect(await matched.rejectionResponse.json()).toMatchObject({
      error: { code: "policy_violation" },
    });

    const unmatched = await keyPolicy.evaluateProviderBudget(KEY, "cursor", { operation: "image generation" });
    expect(unmatched).toMatchObject({ budgetMatched: false, rejectionResponse: null });
    expect(unmatched.releaseReservation).toEqual(expect.any(Function));
  });

  it("atomically reserves fixed cost so concurrent attempts cannot spend the same balance", async () => {
    mockKeyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 1, period: "day" }] },
    };
    keyPolicy._setBudgetQuery(async () => 0.99);
    const warmup = await keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0 });
    warmup.releaseReservation();

    const [first, second] = await Promise.all([
      keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01, operation: "web search" }),
      keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01, operation: "web search" }),
    ]);
    const results = [first, second];

    expect(results.filter((result) => !result.rejectionResponse)).toHaveLength(1);
    expect(results.filter((result) => result.rejectionResponse?.status === 429)).toHaveLength(1);
    results.forEach((result) => result.releaseReservation());

    const retry = await keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01 });
    expect(retry.rejectionResponse).toBeNull();
    retry.releaseReservation();
  });

  it("makes budget available after a failed attempt releases its reservation", async () => {
    mockKeyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 1, period: "day" }] },
    };
    keyPolicy._setBudgetQuery(async () => 0.99);

    const failedAttempt = await keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01 });
    expect(failedAttempt.rejectionResponse).toBeNull();
    failedAttempt.releaseReservation();
    failedAttempt.releaseReservation();

    const retry = await keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01 });
    expect(retry.rejectionResponse).toBeNull();
    retry.releaseReservation();
  });

  it("clears reservations when key policy state is reset", async () => {
    mockKeyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 1, period: "day" }] },
    };
    keyPolicy._setBudgetQuery(async () => 0.99);

    const beforeReset = await keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01 });
    keyPolicy._resetKeyPolicyState();
    const afterReset = await keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01 });
    expect(afterReset.rejectionResponse).toBeNull();

    beforeReset.releaseReservation();
    const stillReserved = await keyPolicy.evaluateProviderBudget(KEY, "tavily", { costUsd: 0.01 });
    expect(stillReserved.rejectionResponse?.status).toBe(429);
    afterReset.releaseReservation();
  });

  it("returns a short 429 without opening a breaker for projected rejection", async () => {
    mockKeyRecord = {
      policy: { budgets: [{ provider: "*", limitUsd: 1, period: "day" }] },
    };
    keyPolicy._setBudgetQuery(async () => 0.995);

    const result = await keyPolicy.evaluateProviderBudget(KEY, "tavily", {
      costUsd: 0.008,
      operation: "web search",
    });

    expect(result.budgetMatched).toBe(true);
    expect(result.rejectionResponse.status).toBe(429);
    expect(result.rejectionResponse.headers.get("retry-after")).toBe("1");

    const cheaperAttempt = await keyPolicy.evaluateProviderBudget(KEY, "tavily", {
      costUsd: 0.001,
      operation: "web search",
    });
    expect(cheaperAttempt.rejectionResponse).toBeNull();

    const status = await keyPolicy.getKeyPolicyStatus(KEY);
    expect(status.breaker).toBeNull();
    expect(status.providerBreakers).toEqual([]);
    cheaperAttempt.releaseReservation();
  });
});

describe("bumpBudgetCache", () => {
  it("keeps day, week, and month caches distinct when their starts coincide", async () => {
    const mondayMonthStart = Date.parse("2026-06-01T12:00:00.000Z");
    let queries = 0;
    keyPolicy._setBudgetQuery(async (_key, _provider, startMs, endMs) => {
      queries += 1;
      const days = (endMs - startMs) / 86400000;
      if (days === 1) return 1;
      if (days === 7) return 2;
      return 3;
    });
    const policy = {
      budgets: [
        { provider: "tavily", limitUsd: 1.5, period: "day" },
        { provider: "tavily", limitUsd: 2.5, period: "week" },
        { provider: "tavily", limitUsd: 3.5, period: "month" },
      ],
    };

    expect((await keyPolicy.checkBudget(KEY, policy, "tavily", mondayMonthStart)).ok).toBe(true);
    expect(queries).toBe(3);
  });

  it("increments cached spend for matching windows", async () => {
    keyPolicy._setBudgetQuery(async () => 4);
    const policy = { budgets: [{ provider: "codex", limitUsd: 5, period: "day" }] };

    // Prime the cache (4 < 5 → ok)
    expect((await keyPolicy.checkBudget(KEY, policy, "codex")).ok).toBe(true);

    // Simulate a usage insert pushing spend over budget without touching DB
    keyPolicy.bumpBudgetCache(KEY, "codex", 2);

    expect((await keyPolicy.checkBudget(KEY, policy, "codex")).ok).toBe(false);
  });

  it("does not bump a new period with usage accounted to the previous period", async () => {
    vi.useFakeTimers();
    try {
      const oldWindow = Date.parse("2026-08-30T23:59:59.900Z");
      const newWindow = Date.parse("2026-08-31T00:00:00.100Z");
      const policy = { budgets: [{ provider: "tavily", limitUsd: 0.5, period: "day" }] };
      keyPolicy._setBudgetQuery(async () => 0);

      vi.setSystemTime(oldWindow);
      expect((await keyPolicy.checkBudget(KEY, policy, "tavily", oldWindow)).ok).toBe(true);
      vi.setSystemTime(newWindow);
      expect((await keyPolicy.checkBudget(KEY, policy, "tavily", newWindow)).ok).toBe(true);

      keyPolicy.bumpBudgetCache(KEY, "tavily", 1, oldWindow);
      expect((await keyPolicy.checkBudget(KEY, policy, "tavily", newWindow)).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidateKeyPolicy forces a fresh DB read on next check", async () => {
    let queries = 0;
    keyPolicy._setBudgetQuery(async () => { queries += 1; return 1; });
    const policy = { budgets: [{ provider: "codex", limitUsd: 5, period: "day" }] };

    await keyPolicy.checkBudget(KEY, policy, "codex");
    await keyPolicy.checkBudget(KEY, policy, "codex"); // cache hit, no new query
    expect(queries).toBe(1);

    keyPolicy.invalidateKeyPolicy(KEY);
    await keyPolicy.checkBudget(KEY, policy, "codex");
    expect(queries).toBe(2);
  });
});

describe("getKeyPolicyStatus", () => {
  it("reports inflight, budget spend, and usage for a policy key", async () => {
    mockKeyRecord = {
      policy: { maxConcurrent: 3, budgets: [{ provider: "codex", limitUsd: 5, period: "day" }] },
    };
    keyPolicy._setBudgetQuery(async (_key, provider) => (provider === "*" ? 3.5 : 2));

    const policy = { maxConcurrent: 3 };
    keyPolicy.acquireSlot(KEY, policy);
    keyPolicy.acquireSlot(KEY, policy);

    const st = await keyPolicy.getKeyPolicyStatus(KEY, { skipCache: true });
    expect(st.hasPolicy).toBe(true);
    expect(st.maxConcurrent).toBe(3);
    expect(st.inflight).toBe(2);
    expect(st.budgets).toHaveLength(1);
    expect(st.budgets[0]).toMatchObject({ provider: "codex", period: "day", limitUsd: 5, spentUsd: 2 });
    expect(st.usage).toMatchObject({ day: 3.5, week: 3.5, month: 3.5 });
    expect(st.breaker).toBeNull();
    expect(st.providerBreakers).toEqual([]);
  });

  it("reports usage even for keys without a policy", async () => {
    mockKeyRecord = null;
    keyPolicy._setBudgetQuery(async () => 1.25);

    const st = await keyPolicy.getKeyPolicyStatus(KEY, { skipCache: true });
    expect(st.hasPolicy).toBe(false);
    expect(st.maxConcurrent).toBeNull();
    expect(st.inflight).toBe(0);
    expect(st.budgets).toEqual([]);
    expect(st.usage.day).toBe(1.25);
  });

  it("surfaces open key and provider breakers", async () => {
    mockKeyRecord = { policy: { budgets: [{ provider: "codex", limitUsd: 5, period: "day" }] } };
    keyPolicy._setBudgetQuery(async () => 100);

    // Trip the codex provider breaker first (provider-specific budget),
    // then the whole-key breaker (wildcard budget) — separate checks since
    // checkBudget returns on the first violation.
    await keyPolicy.checkBudget(KEY, { budgets: [{ provider: "codex", limitUsd: 1, period: "day" }] }, "codex");
    await keyPolicy.checkBudget(KEY, { budgets: [{ provider: "*", limitUsd: 1, period: "day" }] }, "codex");

    const st = await keyPolicy.getKeyPolicyStatus(KEY, { skipCache: true });
    expect(st.breaker).toMatchObject({ scope: "key" });
    expect(st.breaker.untilMs).toBeGreaterThan(Date.now());
    expect(st.providerBreakers).toHaveLength(1);
    expect(st.providerBreakers[0]).toMatchObject({ provider: "codex" });
    expect(st.providerBreakers[0].untilMs).toBeGreaterThan(Date.now());
    expect(st.providerBreakers[0].reason).toContain("budget exceeded");
  });
});
