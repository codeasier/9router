// /v1/usage endpoint — per-API-key usage introspection.
// Covers:
//   * Auth (Bearer / x-api-key, missing/inactive, no echo of raw key)
//   * Window validation (defaults, max days, future end, bad RFC 3339, bad tz)
//   * Aggregation correctness vs usageHistory rows
//   * Client-tz byDay bucketing
//   * Rate limit + response cache behaviour
//   * Truncation flag
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-api-"));
  process.env.DATA_DIR = tempDir;
  // Reset module cache so the DB picks up our temp dir.
  const { vi } = await import("vitest");
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(async () => {
  const { _resetUsageApiState } = await import("@/sse/services/usageApiGuard.js");
  _resetUsageApiState();
});

const day = (iso) => new Date(iso).getTime();

async function makeKey(name = "primary") {
  return await db.createApiKey(name, "machine-test");
}

async function saveUsageRow({ apiKey, timestamp, model = "gpt-4", provider = "openai", promptTokens = 0, completionTokens = 0, cachedTokens = 0, cost = 0 }) {
  await db.saveRequestUsage({
    apiKey,
    timestamp,
    provider,
    model,
    tokens: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cached_tokens: cachedTokens,
    },
    cost,
    endpoint: "/v1/chat/completions",
    status: "ok",
  });
}

function buildRequest(url, headers = {}) {
  return new Request(url, { headers: new Headers(headers) });
}

async function call(handler, url, headers) {
  return await handler(buildRequest(url, headers));
}

describe("/v1/usage — auth", () => {
  it("401 with UNAUTHORIZED when no API key header is present", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const res = await call(GET, "http://localhost/v1/usage");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBeTruthy();
  });

  it("401 with INVALID_API_KEY for unknown key, with no key-related echo", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const res = await call(GET, "http://localhost/v1/usage", {
      authorization: "Bearer sk-does-not-exist-aaaaaa-00000000",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_API_KEY");
    // Error body must NOT echo the key, fingerprint, or any prefix of the value.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("sk-does-not-exist");
    expect(serialized).not.toMatch(/sha256:/);
  });

  it("401 with INVALID_API_KEY for inactive key", async () => {
    const k = await makeKey("inactive");
    await db.updateApiKey(k.id, { isActive: false });
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const res = await call(GET, "http://localhost/v1/usage", {
      authorization: `Bearer ${k.key}`,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_API_KEY");
  });

  it("accepts x-api-key header as well as Authorization Bearer", async () => {
    const k = await makeKey("both");
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const res = await call(GET, "http://localhost/v1/usage", {
      "x-api-key": k.key,
    });
    expect(res.status).toBe(200);
  });
});

describe("/v1/usage — period validation", () => {
  let primary;
  beforeAll(async () => {
    primary = await makeKey("period-test");
  });

  it("uses last-7d defaults when start/end are both absent", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const res = await call(GET, "http://localhost/v1/usage", {
      authorization: `Bearer ${primary.key}`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period.days).toBeGreaterThanOrEqual(6);
    expect(body.period.days).toBeLessThanOrEqual(8);
  });

  it("rejects bad RFC 3339 timestamps", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const res = await call(GET, "http://localhost/v1/usage?start=not-a-date", {
      authorization: `Bearer ${primary.key}`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_PERIOD");
  });

  it("rejects start >= end", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const url = "http://localhost/v1/usage?start=2026-07-01T00:00:00Z&end=2026-06-30T00:00:00Z";
    const res = await call(GET, url, { authorization: `Bearer ${primary.key}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_PERIOD");
  });

  it("rejects end in the future", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const url = `http://localhost/v1/usage?end=${new Date(Date.now() + 10 * 86400000).toISOString()}`;
    const res = await call(GET, url, { authorization: `Bearer ${primary.key}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_PERIOD");
  });

  it("rejects windows > MAX_DAYS", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    // Anchor both ends in the recent past so the "future end" check doesn't
    // fire first — we want PERIOD_TOO_LARGE specifically.
    const now = Date.now();
    const tooFar = now - 100 * 86400000; // 100 days ago
    const veryRecent = now - 1000;
    const url = `http://localhost/v1/usage?start=${new Date(tooFar).toISOString()}&end=${new Date(veryRecent).toISOString()}`;
    const res = await call(GET, url, { authorization: `Bearer ${primary.key}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("PERIOD_TOO_LARGE");
  });

  it("rejects invalid timezone", async () => {
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const url = "http://localhost/v1/usage?timezone=Mars/Olympus";
    const res = await call(GET, url, { authorization: `Bearer ${primary.key}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_PERIOD");
  });
});

describe("/v1/usage — aggregation correctness", () => {
  it("returns total/byModel/byDay consistent with usageHistory rows for that key only", async () => {
    const k = await makeKey("aggregation");
    const otherKey = await makeKey("other");

    // Rows in window for `k`.
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-01T03:00:00Z", model: "gpt-4", promptTokens: 100, completionTokens: 50, cachedTokens: 10, cost: 0.005 });
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-01T11:30:00Z", model: "gpt-4", promptTokens: 200, completionTokens: 80, cachedTokens: 0, cost: 0.012 });
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-02T05:00:00Z", model: "claude-3-5-sonnet", promptTokens: 300, completionTokens: 120, cachedTokens: 50, cost: 0.020 });

    // Rows in window for `otherKey` — must NOT leak.
    await saveUsageRow({ apiKey: otherKey.key, timestamp: "2026-07-01T03:00:00Z", model: "gpt-4", promptTokens: 9999, completionTokens: 9999, cost: 9.999 });

    const { GET } = await import("@/app/api/v1/usage/route.js");
    const url =
      "http://localhost/v1/usage?start=2026-07-01T00:00:00Z&end=2026-07-03T00:00:00Z&timezone=UTC";
    const res = await call(GET, url, { authorization: `Bearer ${k.key}` });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.apiKey.id).toBe(k.id);
    expect(body.apiKey.name).toBe("aggregation");

    expect(body.total.requests).toBe(3);
    expect(body.total.promptTokens).toBe(600);
    expect(body.total.completionTokens).toBe(250);
    expect(body.total.cachedTokens).toBe(60);

    expect(body.byModel).toHaveLength(2);
    const gpt4 = body.byModel.find((m) => m.model === "gpt-4");
    expect(gpt4.requests).toBe(2);
    expect(gpt4.promptTokens).toBe(300);
    expect(gpt4.completionTokens).toBe(130);
    const claude = body.byModel.find((m) => m.model === "claude-3-5-sonnet");
    expect(claude.requests).toBe(1);
    expect(claude.cost).toBeGreaterThan(0);

    expect(body.byDay).toHaveLength(2);
    const d1 = body.byDay.find((d) => d.date === "2026-07-01");
    expect(d1.requests).toBe(2);
    expect(d1.promptTokens).toBe(300);
    const d2 = body.byDay.find((d) => d.date === "2026-07-02");
    expect(d2.requests).toBe(1);
    expect(d2.promptTokens).toBe(300);

    // Truncation must be false for a tiny dataset.
    expect(body.truncated).toBe(false);

    // Response MUST NOT leak raw key material.
    const ser = JSON.stringify(body);
    expect(ser).not.toContain(k.key);
    expect(ser).not.toContain(otherKey.key);
    expect(ser).not.toMatch(/sha256:/);
  });

  it("buckets byDay by client timezone, not UTC", async () => {
    const k = await makeKey("tz-bucket");
    // 2026-07-01T17:00:00Z is 2026-07-02T01:00 in Asia/Shanghai.
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-01T17:00:00Z", model: "gpt-4", promptTokens: 10, completionTokens: 5 });
    // 2026-07-02T15:00:00Z is 2026-07-02T23:00 in Asia/Shanghai.
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-02T15:00:00Z", model: "gpt-4", promptTokens: 20, completionTokens: 10 });

    const { GET } = await import("@/app/api/v1/usage/route.js");

    const urlUtc =
      "http://localhost/v1/usage?start=2026-07-01T00:00:00Z&end=2026-07-04T00:00:00Z&timezone=UTC";
    const bodyUtc = await (await call(GET, urlUtc, { authorization: `Bearer ${k.key}` })).json();
    expect(bodyUtc.byDay.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(bodyUtc.byDay[0].requests).toBe(1);
    expect(bodyUtc.byDay[1].requests).toBe(1);

    const urlSh =
      "http://localhost/v1/usage?start=2026-07-01T00:00:00Z&end=2026-07-04T00:00:00Z&timezone=Asia/Shanghai";
    const bodySh = await (await call(GET, urlSh, { authorization: `Bearer ${k.key}` })).json();
    // Both rows fall into 2026-07-02 Asia/Shanghai (one at 01:00, one at 23:00).
    // 2026-07-01 stays in the window (UTC midnight + 8h), but it has zero
    // records so the bucket comes back empty rather than absent.
    expect(bodySh.byDay.find((d) => d.date === "2026-07-02").requests).toBe(2);
    expect(bodySh.byDay.find((d) => d.date === "2026-07-01")?.requests || 0).toBe(0);
    expect(bodySh.period.timezone).toBe("Asia/Shanghai");
  });

  it("filters rows outside the requested window", async () => {
    const k = await makeKey("window-filter");
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-06-15T00:00:00Z", model: "gpt-4", promptTokens: 1000, completionTokens: 0 });
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-15T00:00:00Z", model: "gpt-4", promptTokens: 2000, completionTokens: 0 });
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-20T00:00:00Z", model: "gpt-4", promptTokens: 4000, completionTokens: 0 });

    const { GET } = await import("@/app/api/v1/usage/route.js");
    const url =
      "http://localhost/v1/usage?start=2026-07-10T00:00:00Z&end=2026-07-25T00:00:00Z&timezone=UTC";
    const body = await (await call(GET, url, { authorization: `Bearer ${k.key}` })).json();

    expect(body.total.requests).toBe(2);
    expect(body.total.promptTokens).toBe(6000);
  });

  it("byDay includes DST transition days in the client timezone", async () => {
    const k = await makeKey("dst");
    // America/New_York spring-forward day is 2026-03-08 (a 23h calendar day).
    // A row on the transition day itself plus one on each adjacent day.
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-03-07T12:00:00Z", model: "gpt-4", promptTokens: 1, completionTokens: 1 });
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-03-08T12:00:00Z", model: "gpt-4", promptTokens: 5, completionTokens: 5 });
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-03-09T12:00:00Z", model: "gpt-4", promptTokens: 2, completionTokens: 2 });

    const { GET } = await import("@/app/api/v1/usage/route.js");
    // Sampling phase at 04:30Z used to skip the transition day entirely.
    const url =
      "http://localhost/v1/usage?start=2026-03-07T04:30:00Z&end=2026-03-10T04:30:00Z&timezone=America/New_York";
    const body = await (await call(GET, url, { authorization: `Bearer ${k.key}` })).json();

    const dates = body.byDay.map((d) => d.date);
    expect(dates).toContain("2026-03-07");
    expect(dates).toContain("2026-03-08");
    expect(dates).toContain("2026-03-09");
    const t8 = body.byDay.find((d) => d.date === "2026-03-08");
    expect(t8.requests).toBe(1);
    expect(t8.promptTokens).toBe(5);
    expect(body.total.requests).toBe(3);
  });
});

describe("/v1/usage — cache and rate limit", () => {
  it("serves cached responses for identical requests within TTL", async () => {
    const k = await makeKey("cache");
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const url =
      "http://localhost/v1/usage?start=2026-07-01T00:00:00Z&end=2026-07-02T00:00:00Z&timezone=UTC";
    const r1 = await call(GET, url, { authorization: `Bearer ${k.key}` });
    const r2 = await call(GET, url, { authorization: `Bearer ${k.key}` });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(await r1.json()).toEqual(await r2.json());
  });

  it("rate limits per-key and returns 429 with retry-after header", async () => {
    const { USAGE_API_LIMITS, checkRateLimit } = await import(
      "@/sse/services/usageApiGuard.js"
    );
    const k = "rl-key-id";
    for (let i = 0; i < USAGE_API_LIMITS.RATE_LIMIT_MAX; i++) {
      expect(checkRateLimit(k).ok).toBe(true);
    }
    const blocked = checkRateLimit(k);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // Route-level: hit the cap and confirm 429 + retry-after header.
    const apiKey = await makeKey("ratelimit");
    const { GET } = await import("@/app/api/v1/usage/route.js");
    const url = "http://localhost/v1/usage?start=2026-07-01T00:00:00Z&end=2026-07-02T00:00:00Z";
    // Burn through the per-key limit. Use unique window params so each call
    // misses the cache and exercises the limiter.
    let lastStatus = 0;
    for (let i = 0; i < USAGE_API_LIMITS.RATE_LIMIT_MAX + 2; i++) {
      const u = `${url}&_=${i}`;
      const r = await call(GET, u, { authorization: `Bearer ${apiKey.key}` });
      lastStatus = r.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
    // Re-issue and check headers.
    const r = await call(GET, `${url}&_=final`, { authorization: `Bearer ${apiKey.key}` });
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("rate limits are isolated per apiKeyId", async () => {
    const { checkRateLimit, _resetUsageApiState } = await import(
      "@/sse/services/usageApiGuard.js"
    );
    _resetUsageApiState();
    const a = "id-a";
    const b = "id-b";
    for (let i = 0; i < 61; i++) checkRateLimit(a);
    expect(checkRateLimit(a).ok).toBe(false);
    expect(checkRateLimit(b).ok).toBe(true);
  });

  it("rate limiter enforces a true sliding window", async () => {
    const { checkRateLimit, USAGE_API_LIMITS, _resetUsageApiState } = await import(
      "@/sse/services/usageApiGuard.js"
    );
    _resetUsageApiState();
    const id = "sliding";
    const MAX = USAGE_API_LIMITS.RATE_LIMIT_MAX;

    // 60 requests at t=0 all pass; the 61st in the same instant is blocked.
    for (let i = 0; i < MAX; i++) expect(checkRateLimit(id, 0).ok).toBe(true);
    expect(checkRateLimit(id, 0).ok).toBe(false);

    // Still blocked near the end of the window (the t=0 burst hasn't aged out).
    expect(checkRateLimit(id, 59000).ok).toBe(false);

    // Exactly one window later the oldest requests have aged out.
    expect(checkRateLimit(id, 60000).ok).toBe(true);

    // A new burst is again capped at MAX within any rolling window.
    for (let i = 1; i < MAX; i++) expect(checkRateLimit(id, 60000).ok).toBe(true);
    expect(checkRateLimit(id, 60001).ok).toBe(false);
  });

  it("rate limiter prunes idle entries so the map stays bounded", async () => {
    const { checkRateLimit, _rateMapSize, _resetUsageApiState } = await import(
      "@/sse/services/usageApiGuard.js"
    );
    _resetUsageApiState();
    checkRateLimit("idle-1", 0);
    checkRateLimit("idle-2", 0);
    checkRateLimit("idle-3", 0);
    expect(_rateMapSize()).toBe(3);

    // A request two windows later triggers the periodic prune — idle keys go.
    checkRateLimit("active", 120000);
    expect(_rateMapSize()).toBe(1);
  });
});

describe("/v1/usage — repo: getUsageForApiKey + getApiKeyByKey", () => {
  it("getApiKeyByKey returns the row including id/name/isActive", async () => {
    const k = await makeKey("by-key");
    const found = await db.getApiKeyByKey(k.key);
    expect(found.id).toBe(k.id);
    expect(found.name).toBe("by-key");
    expect(found.isActive).toBe(true);
  });

  it("getUsageForApiKey throws on invalid window", async () => {
    const k = await makeKey("invalid-window");
    await expect(
      db.getUsageForApiKey({ apiKey: k.key, startMs: 1000, endMs: 1000, timeZone: "UTC" })
    ).rejects.toThrow();
  });

  it("getUsageForApiKey round-trips totals consistently", async () => {
    const k = await makeKey("roundtrip");
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-01T01:00:00Z", model: "m1", promptTokens: 7, completionTokens: 3, cost: 0.001 });
    await saveUsageRow({ apiKey: k.key, timestamp: "2026-07-02T01:00:00Z", model: "m1", promptTokens: 13, completionTokens: 5, cost: 0.002 });
    const out = await db.getUsageForApiKey({
      apiKey: k.key,
      startMs: day("2026-07-01T00:00:00Z"),
      endMs: day("2026-07-03T00:00:00Z"),
      timeZone: "UTC",
    });
    expect(out.total.requests).toBe(2);
    expect(out.total.promptTokens).toBe(20);
    expect(out.total.completionTokens).toBe(8);
    expect(out.byModel).toEqual([
      expect.objectContaining({ model: "m1", requests: 2, promptTokens: 20, completionTokens: 8 }),
    ]);
    expect(out.byDay.find((d) => d.date === "2026-07-01").requests).toBe(1);
    expect(out.byDay.find((d) => d.date === "2026-07-02").requests).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it("truncates when result hits MAX_USAGE_QUERY_ROWS", async () => {
    const k = await makeKey("trunc");
    // Bulk insert > MAX rows via the adapter's `run` (works across drivers).
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    adapter.transaction(() => {
      const ts = "2026-07-01T00:00:00Z";
      for (let i = 0; i < db.USAGE_QUERY_LIMITS.MAX_ROWS + 5; i++) {
        adapter.run(
          `INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ts, "p", `model-${i}`, k.key, 1, 1, 0, "ok", "{}", "{}"]
        );
      }
    });
    const out = await db.getUsageForApiKey({
      apiKey: k.key,
      startMs: day("2026-07-01T00:00:00Z"),
      endMs: day("2026-07-02T00:00:00Z"),
      timeZone: "UTC",
    });
    expect(out.truncated).toBe(true);
    expect(out.total.requests).toBe(db.USAGE_QUERY_LIMITS.MAX_ROWS);
  });
});

describe("/v1/usage — migration", () => {
  it("registered idx_uh_apiKey_ts is created on db init", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const rows = adapter.all(`PRAGMA index_list(usageHistory)`);
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_uh_apiKey_ts");
  });
});