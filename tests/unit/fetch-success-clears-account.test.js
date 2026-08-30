import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  handleFetchCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  saveRequestUsage: vi.fn(),
  policyRecord: null,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getCombos: mocks.getCombos,
  getApiKeyByKey: async () => mocks.policyRecord,
}));

vi.mock("open-sse/handlers/fetch/index.js", () => ({
  handleFetchCore: mocks.handleFetchCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrlResolved: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
}));

import { handleFetch } from "@/sse/handlers/fetch.js";
import { _resetKeyPolicyState, _setBudgetQuery } from "@/sse/services/keyPolicy.js";

describe("web fetch account state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKeyPolicyState();
    _setBudgetQuery(async () => 0);
    mocks.policyRecord = null;
    mocks.extractApiKey.mockReturnValue(null);
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getCombos.mockResolvedValue([]);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "jina-test-key",
      connectionId: "jina-connection",
      connectionName: "Jina Test",
      _connection: {
        testStatus: "unavailable",
        lastError: "old error",
        modelLock___all: "2026-01-01T00:00:00.000Z",
      },
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleFetchCore.mockResolvedValue({
      success: true,
      data: { provider: "jina-reader", content: { text: "ok" } },
    });
  });

  it("clears a stale provider lock after a successful fetch", async () => {
    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "jina-connection",
      expect.objectContaining({ connectionName: "Jina Test" }),
      "webfetch:jina-reader",
    );
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "jina-reader",
      expect.any(Set),
      "webfetch:jina-reader",
    );
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "jina-reader",
      model: "fetch",
      connectionId: "jina-connection",
      apiKey: null,
      endpoint: "/v1/web/fetch",
      costUsd: 0,
      requestId: expect.any(String),
      tokens: {},
    }));
  });

  it("does not record a failed fetch attempt", async () => {
    mocks.handleFetchCore.mockResolvedValue({
      success: false,
      status: 502,
      error: "upstream failed",
    });

    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
    }));

    expect(response.status).toBe(502);
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("releases a fixed-cost reservation after a failed fetch attempt", async () => {
    mocks.extractApiKey.mockReturnValue("client-key");
    mocks.policyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 0.008, period: "day" }] },
    };
    mocks.handleFetchCore
      .mockResolvedValueOnce({ success: false, status: 502, error: "upstream failed" })
      .mockResolvedValue({ success: true, data: { provider: "tavily", content: { text: "ok" } } });
    const makeRequest = () => new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "tavily",
        url: "https://example.com/article",
      }),
    });

    expect((await handleFetch(makeRequest())).status).toBe(502);
    expect((await handleFetch(makeRequest())).status).toBe(200);
    expect(mocks.handleFetchCore).toHaveBeenCalledTimes(2);
  });

  it("scopes provider failures to web fetch", async () => {
    mocks.handleFetchCore.mockResolvedValue({
      success: false,
      status: 429,
      error: "quota exceeded",
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });

    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
    }));

    expect(response.status).toBe(429);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "jina-connection",
      429,
      "quota exceeded",
      "jina-reader",
      "webfetch:jina-reader",
    );
  });
});
