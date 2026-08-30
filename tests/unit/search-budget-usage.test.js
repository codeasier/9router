import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policyRecord: null,
  handleSearchCore: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({
    apiKey: "provider-secret",
    connectionId: "tavily-connection",
    connectionName: "Tavily",
  }),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getCombos: async () => [],
  getApiKeyByKey: async () => mocks.policyRecord,
}));

vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: mocks.handleSearchCore,
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));

import { handleSearch } from "@/sse/handlers/search.js";
import { _resetKeyPolicyState, _setBudgetQuery } from "@/sse/services/keyPolicy.js";

function request(provider = "tavily") {
  return new Request("http://localhost/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, query: "latest release" }),
  });
}

describe("search budget accounting", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    _resetKeyPolicyState();
    _setBudgetQuery(async () => 0);
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.policyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 5, period: "day" }] },
    };
    mocks.handleSearchCore.mockResolvedValue({
      success: true,
      data: { provider: "tavily", usage: { search_cost_usd: 0.008 } },
      response: Response.json({ provider: "tavily" }),
    });
  });

  it("records a successful fixed-cost dedicated attempt and disables chat fallback", async () => {
    const response = await handleSearch(request());

    expect(response.status).toBe(200);
    expect(mocks.handleSearchCore).toHaveBeenCalledWith(expect.objectContaining({
      allowChatFallback: false,
    }));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "tavily",
      model: "search",
      connectionId: "tavily-connection",
      apiKey: "client-key",
      endpoint: "/v1/search",
      costUsd: 0.008,
      requestId: expect.any(String),
      tokens: {},
    }));
  });

  it("fails closed before an unpriced dedicated search attempt", async () => {
    mocks.policyRecord = {
      policy: { budgets: [{ provider: "xquik", limitUsd: 5, period: "day" }] },
    };

    const response = await handleSearch(request("xquik"));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("policy_violation");
    expect(mocks.handleSearchCore).not.toHaveBeenCalled();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("does not account a failed dedicated attempt", async () => {
    mocks.handleSearchCore.mockResolvedValue({
      success: false,
      status: 502,
      error: "upstream failed",
      response: Response.json({ error: "upstream failed" }, { status: 502 }),
    });

    const response = await handleSearch(request());

    expect(response.status).toBe(502);
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("holds the reservation until successful usage persistence completes", async () => {
    mocks.policyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 0.008, period: "day" }] },
    };
    let finishSave;
    mocks.saveRequestUsage.mockImplementation(() => new Promise((resolve) => {
      finishSave = resolve;
    }));

    const firstResponse = handleSearch(request());
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));

    const concurrentResponse = await handleSearch(request());
    expect(concurrentResponse.status).toBe(429);
    expect(mocks.handleSearchCore).toHaveBeenCalledTimes(1);

    finishSave();
    expect((await firstResponse).status).toBe(200);
  });

  it("releases the reservation after a failed provider attempt", async () => {
    mocks.policyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 0.008, period: "day" }] },
    };
    mocks.handleSearchCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      error: "upstream failed",
      response: Response.json({ error: "upstream failed" }, { status: 502 }),
    });

    expect((await handleSearch(request())).status).toBe(502);
    expect((await handleSearch(request())).status).toBe(200);
    expect(mocks.handleSearchCore).toHaveBeenCalledTimes(2);
  });

  it("retains the reservation when usage persistence reports failure", async () => {
    mocks.policyRecord = {
      policy: { budgets: [{ provider: "tavily", limitUsd: 0.008, period: "day" }] },
    };
    mocks.saveRequestUsage.mockResolvedValue(false);

    expect((await handleSearch(request())).status).toBe(200);
    expect((await handleSearch(request())).status).toBe(429);
    expect(mocks.handleSearchCore).toHaveBeenCalledTimes(1);
  });

  it("accounts a request in the same budget window that reserved its cost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T23:59:59.900Z"));
    mocks.saveRequestUsage.mockResolvedValue(true);
    mocks.handleSearchCore.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-08-31T00:00:00.100Z"));
      return {
        success: true,
        data: { provider: "tavily", usage: { search_cost_usd: 0.008 } },
        response: Response.json({ provider: "tavily" }),
      };
    });

    expect((await handleSearch(request())).status).toBe(200);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: "2026-08-30T23:59:59.900Z",
    }));
  });

  it("keeps unbudgeted chat fallback unpriced and unaccounted", async () => {
    mocks.policyRecord = null;
    mocks.handleSearchCore.mockResolvedValue({
      success: true,
      data: { provider: "tavily", usage: { search_cost_usd: null } },
      response: Response.json({ provider: "tavily" }),
    });

    const response = await handleSearch(request());

    expect(response.status).toBe(200);
    expect(mocks.handleSearchCore).toHaveBeenCalledWith(expect.objectContaining({
      allowChatFallback: true,
    }));
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
});
