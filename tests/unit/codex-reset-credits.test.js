import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn(),
  getActiveCodexResetCreditAttempt: vi.fn(),
  getLatestCodexResetCreditAttempt: vi.fn(),
  createCodexResetCreditAttempt: vi.fn(),
  updateCodexResetCreditAttempt: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: vi.fn(),
  getSettings: mocks.getSettings,
  getActiveCodexResetCreditAttempt: mocks.getActiveCodexResetCreditAttempt,
  getLatestCodexResetCreditAttempt: mocks.getLatestCodexResetCreditAttempt,
  createCodexResetCreditAttempt: mocks.createCodexResetCreditAttempt,
  updateCodexResetCreditAttempt: mocks.updateCodexResetCreditAttempt,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getCodexRateLimitResetCredits: mocks.getCodexRateLimitResetCredits,
  consumeCodexRateLimitResetCredit: mocks.consumeCodexRateLimitResetCredit,
}));

describe("Codex reset credits", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getActiveCodexResetCreditAttempt.mockResolvedValue(null);
    mocks.getLatestCodexResetCreditAttempt.mockResolvedValue(null);
    mocks.getSettings.mockResolvedValue({ codexResetCreditAutoUseMinutes: 10 });
    mocks.createCodexResetCreditAttempt.mockImplementation(async (attempt) => attempt);
    mocks.updateCodexResetCreditAttempt.mockImplementation(async (_id, updates) => updates);
    mocks.getCodexRateLimitResetCredits.mockResolvedValue({
      availableCount: 1,
      credits: [{ id: "credit-1", status: "available", expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }],
    });
  });

  it("uses workspaceId then chatgptAccountId then accountId as canonical identity", async () => {
    const { getCodexAccountIdentity } = await import("../../open-sse/services/usage/codex.js");
    expect(getCodexAccountIdentity({ workspaceId: "workspace", chatgptAccountId: "chatgpt", accountId: "account" })).toBe("workspace");
    expect(getCodexAccountIdentity({ chatgptAccountId: "chatgpt", accountId: "account" })).toBe("chatgpt");
    expect(getCodexAccountIdentity({ accountId: "account" })).toBe("account");
  });

  it("returns normalized reset credit expiry details", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        available_count: 2,
        credits: [
          {
            status: "available",
            granted_at: "2026-06-18T00:25:18Z",
            expires_at: "2026-07-18T00:25:18Z",
          },
          {
            status: "redeemed",
            granted_at: "bad-date",
            expires_at: null,
          },
        ],
      }),
    });

    const { getCodexRateLimitResetCredits } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexRateLimitResetCredits("token", { strictProxy: false }, { workspaceId: "acct_123" });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/rate-limit-reset-credits"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "ChatGPT-Account-ID": "acct_123",
        }),
      }),
      { strictProxy: false },
    );
    expect(result).toEqual({
      availableCount: 2,
      credits: [
        {
          id: null,
          status: "available",
          grantedAt: "2026-06-18T00:25:18.000Z",
          expiresAt: "2026-07-18T00:25:18.000Z",
        },
        {
          id: null,
          status: "redeemed",
          grantedAt: null,
          expiresAt: null,
        },
      ],
    });
  });

  it("consumes a reset credit in the same Codex workspace used for expiry details", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: "reset", windows_reset: 1 }),
    });

    const { consumeCodexRateLimitResetCredit } = await import("../../open-sse/services/usage/codex.js");
    const result = await consumeCodexRateLimitResetCredit(
      "token",
      "redeem-1",
      { strictProxy: false },
      { workspaceId: "acct_123" },
    );

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/rate-limit-reset-credits/consume"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "ChatGPT-Account-ID": "acct_123",
        }),
        body: JSON.stringify({ redeem_request_id: "redeem-1" }),
      }),
      { strictProxy: false },
    );
    expect(result).toMatchObject({ ok: true, code: "reset", windowsReset: 1 });
  });

  it("GET refreshes OAuth credentials before returning reset credit details", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: { workspaceId: "acct_123" },
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const resetCredits = {
      availableCount: 1,
      credits: [{ status: "available", grantedAt: "2026-06-18T00:25:18.000Z", expiresAt: "2026-07-18T00:25:18.000Z" }],
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local" });
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection: refreshedConnection });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resetCredits);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledWith(
      connection,
      false,
      expect.objectContaining({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local", strictProxy: false }),
    );
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenCalledWith(
      "new-token",
      expect.objectContaining({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local", strictProxy: false }),
      { workspaceId: "acct_123" },
    );
  });

  it("GET force-refreshes OAuth credentials when reset credit fetch reports expired auth", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const forcedConnection = { ...connection, accessToken: "forced-token" };
    const resetCredits = { availableCount: 0, credits: [] };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.refreshAndUpdateCredentials
      .mockResolvedValueOnce({ connection: refreshedConnection })
      .mockResolvedValueOnce({ connection: forcedConnection });
    mocks.getCodexRateLimitResetCredits
      .mockRejectedValueOnce(new Error("Unauthorized 401"))
      .mockResolvedValueOnce(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resetCredits);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenNthCalledWith(1, connection, false, expect.any(Object));
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenNthCalledWith(2, refreshedConnection, true, expect.any(Object));
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenNthCalledWith(2, "forced-token", expect.any(Object), {});
  });

  it("GET preserves the 401 response when proactive OAuth refresh fails", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_refresh_failed",
      provider: "codex",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    });
    mocks.refreshAndUpdateCredentials.mockRejectedValue(new Error("Credential refresh failed"));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_refresh_failed/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn_refresh_failed" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Credential refresh failed" });
    expect(mocks.getCodexRateLimitResetCredits).not.toHaveBeenCalled();
  });

  it("POST returns 409 when there are no reset credits to consume", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_1",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData: {},
    });
    mocks.consumeCodexRateLimitResetCredit.mockResolvedValue({
      ok: false,
      noCredit: true,
      status: 200,
      code: "no_credit",
      windowsReset: 0,
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "no_credit",
      reset: false,
      windows_reset: 0,
      message: "No Codex reset credits available.",
    });
    expect(mocks.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(
      "token",
      expect.any(String),
      expect.objectContaining({ strictProxy: false }),
      {},
    );
  });

  it("auto-use does not consume when the earliest available credit is outside the threshold", async () => {
    const now = Date.now();
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_1",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData: { workspaceId: "acct_auto_not_due" },
    });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue({
      availableCount: 1,
      credits: [{ status: "available", expiresAt: new Date(now + 11 * 60 * 1000).toISOString() }],
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoUseBeforeExpiryMinutes: 10 }),
    }), { params: Promise.resolve({ connectionId: "conn_1" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "not_due", reset: false, auto: true });
    expect(mocks.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("auto-use consumes when the earliest available credit expires within the threshold", async () => {
    const now = Date.now();
    const providerSpecificData = { workspaceId: "acct_123" };
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_auto_due",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData,
    });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue({
      availableCount: 2,
      credits: [
        { status: "redeemed", expiresAt: new Date(now + 60 * 1000).toISOString() },
        { status: "available", grantedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 9 * 60 * 1000).toISOString() },
        { status: "available", expiresAt: new Date(now + 5 * 60 * 1000).toISOString() },
      ],
    });
    mocks.consumeCodexRateLimitResetCredit.mockResolvedValue({
      ok: true,
      noCredit: false,
      status: 200,
      code: "reset",
      windowsReset: 1,
      raw: {},
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_auto_due/codex-reset-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoUseBeforeExpiryMinutes: 10 }),
    }), { params: Promise.resolve({ connectionId: "conn_auto_due" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: "reset", reset: true, windows_reset: 1 });
    expect(mocks.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(
      "token",
      expect.any(String),
      expect.objectContaining({ strictProxy: false }),
      providerSpecificData,
    );
  });

  it("does not let an auto-use POST bypass the disabled server setting", async () => {
    mocks.getSettings.mockResolvedValue({ codexResetCreditAutoUseMinutes: 0 });
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_auto_disabled",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData: { workspaceId: "acct_disabled" },
    });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue({
      availableCount: 1,
      credits: [{ id: "credit-disabled", status: "available", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_auto_disabled/codex-reset-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoUseBeforeExpiryMinutes: 10 }),
    }), { params: Promise.resolve({ connectionId: "conn_auto_disabled" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "disabled", reset: false, auto: true });
    expect(mocks.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("does not label a manual already-consumed response as automatic", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_manual_repeat",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData: {},
    });
    mocks.getLatestCodexResetCreditAttempt.mockResolvedValue({
      id: "attempt-confirmed",
      status: "confirmed",
      availableCountBefore: 1,
      creditFingerprint: "credit-1",
      redeemRequestId: "redeem-confirmed",
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_manual_repeat/codex-reset-credits", {
      method: "POST",
    }), { params: Promise.resolve({ connectionId: "conn_manual_repeat" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "already_consumed", reset: false, auto: false });
  });

  it("rejects an invalid auto-use threshold", async () => {
    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoUseBeforeExpiryMinutes: 0 }),
    }), { params: Promise.resolve({ connectionId: "conn_1" }) });

    expect(response.status).toBe(400);
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
  });

  it("rejects a present nonnumeric auto-use threshold instead of consuming manually", async () => {
    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoUseBeforeExpiryMinutes: "abc" }),
    }), { params: Promise.resolve({ connectionId: "conn_1" }) });

    expect(response.status).toBe(400);
    expect(mocks.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON instead of consuming manually", async () => {
    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    }), { params: Promise.resolve({ connectionId: "conn_1" }) });

    expect(response.status).toBe(400);
    expect(mocks.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });
});
