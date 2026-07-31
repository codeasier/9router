import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  createCodexResetCreditAttempt: vi.fn(),
  getActiveCodexResetCreditAttempt: vi.fn(),
  getLatestCodexResetCreditAttempt: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateCodexResetCreditAttempt: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
}));

const dueCredit = {
  id: "credit-1",
  status: "available",
  grantedAt: "2026-07-31T11:00:00.000Z",
  expiresAt: "2026-07-31T12:05:00.000Z",
};

function connection(id = "conn-1", providerSpecificData = { workspaceId: "workspace-1" }) {
  return {
    id,
    provider: "codex",
    authType: "access_token",
    accessToken: "token",
    providerSpecificData,
  };
}

function createHarness() {
  const activeAttempts = new Map();
  const attempts = [];
  const deps = {
    getSettings: vi.fn().mockResolvedValue({ codexResetCreditAutoUseMinutes: 10 }),
    getProviderConnections: vi.fn(),
    resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
    refreshAndUpdateCredentials: vi.fn(async (value) => ({ connection: value })),
    getResetCredits: vi.fn().mockResolvedValue({ availableCount: 1, credits: [dueCredit] }),
    consumeResetCredit: vi.fn().mockResolvedValue({ ok: true, status: 200, code: "reset", windowsReset: 1 }),
    getActiveAttempt: vi.fn(async (accountIdentity) => activeAttempts.get(accountIdentity) || null),
    getLatestAttempt: vi.fn(async (accountIdentity, creditFingerprint) =>
      [...attempts].reverse().find((attempt) =>
        attempt.accountIdentity === accountIdentity && attempt.creditFingerprint === creditFingerprint
      ) || null
    ),
    createAttempt: vi.fn(async (attempt) => {
      const active = activeAttempts.get(attempt.accountIdentity);
      if (active) return active;
      const created = { ...attempt };
      activeAttempts.set(attempt.accountIdentity, created);
      attempts.push(created);
      return created;
    }),
    updateAttempt: vi.fn(async (id, updates) => {
      const entry = [...activeAttempts.entries()].find(([, attempt]) => attempt.id === id);
      if (entry) {
        const [accountIdentity, attempt] = entry;
        const updated = Object.assign(attempt, updates);
        if (["planned", "dispatching", "unknown", "auth_required"].includes(updated.status)) activeAttempts.set(accountIdentity, updated);
        else activeAttempts.delete(accountIdentity);
        return updated;
      }
      return null;
    }),
    randomUUID: vi.fn()
      .mockReturnValueOnce("attempt-1")
      .mockReturnValueOnce("redeem-1")
      .mockReturnValueOnce("attempt-2")
      .mockReturnValueOnce("redeem-2"),
    now: () => Date.parse("2026-07-31T12:00:00.000Z"),
  };
  return { deps, attempts, getActive: (identity = "workspace-1") => activeAttempts.get(identity) || null };
}

describe("Codex reset-credit server service", () => {
  let service;

  beforeEach(async () => {
    vi.resetModules();
    delete global.__codexResetCreditService;
    service = await import("../../src/shared/services/codexResetCreditAutoUse.js");
  });

  it("runs from server settings and groups duplicate connections by canonical account", async () => {
    const harness = createHarness();
    harness.deps.getProviderConnections.mockResolvedValue([
      connection("conn-workspace", { workspaceId: "workspace-1", chatgptAccountId: "chatgpt-other", accountId: "account-other" }),
      connection("conn-duplicate", { workspaceId: "workspace-1" }),
      connection("conn-chatgpt", { chatgptAccountId: "chatgpt-2", accountId: "account-other" }),
      connection("conn-unstable", {}),
    ]);

    await service.runCodexResetCreditAutoUseTick(harness.deps, { running: false, locks: new Map() });

    // One scheduler read plus a pre-dispatch disable check for each account.
    expect(harness.deps.getSettings).toHaveBeenCalledTimes(3);
    expect(harness.deps.consumeResetCredit).toHaveBeenCalledTimes(2);
    expect(harness.deps.consumeResetCredit.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ workspaceId: "workspace-1" }),
      expect.objectContaining({ chatgptAccountId: "chatgpt-2" }),
    ]);
  });

  it("persists an ambiguous dispatch and reuses its redeem id after restart", async () => {
    const harness = createHarness();
    harness.deps.consumeResetCredit
      .mockRejectedValueOnce(new Error("request timed out"))
      .mockResolvedValueOnce({ ok: true, status: 200, code: "reset", windowsReset: 1 });

    const first = await service.useCodexResetCredit(
      connection(),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );
    expect(first.state).toBe("unknown");
    expect(harness.getActive()?.redeemRequestId).toBe("redeem-1");

    const second = await service.useCodexResetCredit(
      connection("conn-after-restart"),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );
    expect(second.state).toBe("confirmed");
    expect(harness.deps.consumeResetCredit.mock.calls.map((call) => call[1])).toEqual(["redeem-1", "redeem-1"]);
    expect(harness.attempts).toHaveLength(1);
  });

  it("does not consume again while successful inventory remains stale", async () => {
    const harness = createHarness();

    const first = await service.useCodexResetCredit(
      connection(),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );
    const second = await service.useCodexResetCredit(
      connection("conn-next-tick"),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );

    expect(first.state).toBe("confirmed");
    expect(second.state).toBe("already_consumed");
    expect(harness.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
    expect(harness.attempts).toHaveLength(1);
  });

  it("keeps an authorization failure recoverable under the same redeem id", async () => {
    const harness = createHarness();
    harness.deps.consumeResetCredit
      .mockResolvedValueOnce({ ok: false, status: 401, code: "token_expired", message: "Unauthorized" })
      .mockResolvedValueOnce({ ok: true, status: 200, code: "reset", windowsReset: 1 });

    const first = await service.useCodexResetCredit(
      connection(),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );
    const second = await service.useCodexResetCredit(
      connection("conn-reauthorized"),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );

    expect(first.state).toBe("auth_required");
    expect(second.state).toBe("confirmed");
    expect(harness.deps.consumeResetCredit.mock.calls.map((call) => call[1])).toEqual(["redeem-1", "redeem-1"]);
    expect(harness.attempts).toHaveLength(1);
  });

  it("blocks a new consume when an ambiguous credit disappears without count evidence", async () => {
    const harness = createHarness();
    harness.deps.consumeResetCredit.mockRejectedValueOnce(new Error("connection reset"));
    await service.useCodexResetCredit(connection(), { auto: true, thresholdMinutes: 10 }, harness.deps, { locks: new Map() });
    harness.deps.getResetCredits.mockResolvedValue({ availableCount: 1, credits: [] });

    const reconciled = await service.useCodexResetCredit(
      connection("conn-after-restart"),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );

    expect(reconciled.state).toBe("unknown");
    expect(harness.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
    expect(harness.attempts).toHaveLength(1);
  });

  it("does not auto-run without a stable Codex account identity", async () => {
    const harness = createHarness();
    const result = await service.useCodexResetCredit(
      connection("unstable", {}),
      { auto: true, thresholdMinutes: 10 },
      harness.deps,
      { locks: new Map() },
    );

    expect(result.state).toBe("unstable_identity");
    expect(harness.deps.getResetCredits).not.toHaveBeenCalled();
    expect(harness.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it("normalizes persisted scheduler configuration", () => {
    expect(service.normalizeCodexResetAutoUseMinutes(undefined)).toBe(0);
    expect(service.normalizeCodexResetAutoUseMinutes("1.6")).toBe(2);
    expect(service.normalizeCodexResetAutoUseMinutes(20000)).toBe(10080);
  });

  it("starts an immediate server poll and stops dynamically", async () => {
    vi.useFakeTimers();
    const db = await import("@/lib/localDb");
    db.getSettings.mockResolvedValue({ codexResetCreditAutoUseMinutes: 10 });
    db.getProviderConnections.mockResolvedValue([]);

    service.configureCodexResetCreditAutoUse({ codexResetCreditAutoUseMinutes: 10 });
    await vi.waitFor(() => expect(db.getSettings).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(1);

    service.configureCodexResetCreditAutoUse({ codexResetCreditAutoUseMinutes: 0 });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
