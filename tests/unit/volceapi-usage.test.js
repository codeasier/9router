import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  estimateModelCredit,
  resolveCreditCoefficient,
  resolveVolceapiLimits,
} from "../../open-sse/services/usage/volceapiCredit.js";
import { VOLCEAPI_API_ROOT, VOLCEAPI_DEFAULT_LIMITS } from "../../open-sse/config/volceapi.js";
import {
  isDepletedQuotaRow,
  filterQuotasForCard,
  parseQuotaData,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MODELS = {
  object: "list",
  data: [
    {
      id: "glm-5.3",
      credit: 1.95,
      credit_history: [
        { from: "2026-08-01", credit: 2.77 },
        { from: "2026-09-14", credit: 1.95 },
      ],
    },
  ],
};

const TODAY_SUMMARY = {
  object: "usage_summary",
  date: "2026-09-16",
  timezone: "Asia/Shanghai",
  data: {
    req_tokens: 16304810,
    rsp_tokens: 239537,
    total_tokens: 16544347,
    cached_tokens: 11996096,
    cache_hit_rate: 0.7357,
    request_count: 265,
  },
};

const TODAY_BY_MODEL = {
  object: "list",
  window: "today",
  data: [
    {
      model: "glm-5.3",
      req_tokens: 5951265,
      rsp_tokens: 69264,
      cached_tokens: 4160192,
      total_tokens: 6020529,
      request_count: 123,
      share: 0.3639,
      daily: [{ date: "2026-09-16", total_tokens: 6020529 }],
    },
  ],
};

const TODAY_BY_PROVIDER = {
  object: "list",
  window: "today",
  data: [
    { provider: "火山", total_tokens: 6269803, request_count: 118, share: 0.379 },
    { provider: "智谱", total_tokens: 5202116, request_count: 86, share: 0.3144 },
  ],
};

function mockUsageApis({
  summary = TODAY_SUMMARY,
  byModel = TODAY_BY_MODEL,
  byProvider = TODAY_BY_PROVIDER,
  models = MODELS,
} = {}) {
  proxyAwareFetch.mockImplementation(async (url) => {
    const href = String(url);
    if (href.includes("/usage/summary")) return jsonResponse(summary);
    if (href.includes("/usage/by-model")) return jsonResponse(byModel);
    if (href.includes("/usage/by-provider")) return jsonResponse(byProvider);
    if (href.endsWith("/models") || href.includes("/models?")) return jsonResponse(models);
    return jsonResponse({ error: href }, 404);
  });
}

describe("volceapi credit math", () => {
  it("applies the date-effective coefficient and does not backfill with the current rate", () => {
    const meta = MODELS.data[0];
    expect(resolveCreditCoefficient("2026-09-10", meta)).toEqual({ coefficient: 2.77, complete: true });
    expect(resolveCreditCoefficient("2026-09-16", meta)).toEqual({ coefficient: 1.95, complete: true });
    expect(estimateModelCredit({
      daily: [
        { date: "2026-09-10", total_tokens: 1_000_000 },
        { date: "2026-09-16", total_tokens: 1_000_000 },
      ],
    }, meta)).toEqual({ credit: 4.72, complete: true });
  });

  it("marks missing model metadata or daily rows incomplete instead of zero", () => {
    expect(estimateModelCredit({ daily: [] }, MODELS.data[0])).toMatchObject({ complete: false });
    expect(estimateModelCredit({ daily: [{ date: "2026-09-16", total_tokens: 1000 }] }, null)).toMatchObject({ complete: false });
  });

  it("uses local default caps and allows connection overrides", () => {
    expect(resolveVolceapiLimits(null)).toEqual(VOLCEAPI_DEFAULT_LIMITS);
    expect(resolveVolceapiLimits({ quotaLimits: { today: 80 } }).today).toBe(80);
  });
});

describe("getUsageForProvider(volceapi)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GETs summary/by-model/by-provider/models with Bearer", async () => {
    mockUsageApis();
    const usage = await getUsageForProvider({ provider: "volceapi", apiKey: "sk-volce" });
    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("火山网关");
    expect(proxyAwareFetch.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(proxyAwareFetch.mock.calls.every(([, opts]) => opts.headers.Authorization === "Bearer sk-volce")).toBe(true);
    expect(proxyAwareFetch.mock.calls.some(([url]) => String(url).startsWith(`${VOLCEAPI_API_ROOT}/usage/summary`))).toBe(true);
  });

  it("shows complete local credit caps and token consumption without absolute remaining", async () => {
    mockUsageApis();
    const usage = await getUsageForProvider({ provider: "volceapi", apiKey: "sk-volce" });
    expect(usage.quotas["Credits (today)"]).toMatchObject({
      used: 11.74,
      total: 150,
      remainingPercentage: 92,
      budgetKind: "local-cap",
    });
    expect(usage.quotas["Credits (today)"].remaining).toBeUndefined();
    expect(usage.quotas["Tokens (today)"]).toMatchObject({
      used: 16544347,
      unlimited: true,
      budgetKind: "tokens",
    });
    expect(usage.note).toMatch(/details/i);
    expect(usage.details.byProvider.today).toEqual([
      { provider: "火山", totalTokens: 6269803, requestCount: 118, share: 0.379 },
      { provider: "智谱", totalTokens: 5202116, requestCount: 86, share: 0.3144 },
    ]);
    expect(usage.details.byModel.today[0]).toMatchObject({
      model: "glm-5.3",
      credit: 11.74,
      creditComplete: true,
      share: 0.3639,
    });
  });

  it("omits local remaining when credit history is missing", async () => {
    mockUsageApis({
      models: { object: "list", data: [{ id: "other-model", credit: 1 }] },
    });
    const usage = await getUsageForProvider({ provider: "volceapi", apiKey: "sk-volce" });
    expect(usage.quotas["Credits (today)"]).toBeUndefined();
    expect(usage.quotas["Tokens (today)"].used).toBe(16544347);
    expect(usage.details.estimateComplete).toBe(false);
    expect(usage.note).toMatch(/incomplete/i);
    expect(usage.note).toMatch(/details/i);
    expect(usage.message).toBeUndefined();
  });

  it("returns a message on missing key / 401 without inventing zero usage", async () => {
    const missing = await getUsageForProvider({ provider: "volceapi" });
    expect(missing.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    const auth = await getUsageForProvider({ provider: "volceapi", apiKey: "bad" });
    expect(auth.message).toMatch(/auth|key/i);
    expect(auth.quotas).toBeUndefined();
  });
});

describe("parseQuotaData(volceapi)", () => {
  it("keeps local-cap rows out of depleted auto-disable", () => {
    const rows = parseQuotaData("volceapi", {
      quotas: {
        "Credits (today)": { used: 149, total: 150, remainingPercentage: 1, budgetKind: "local-cap" },
        "Tokens (today)": { used: 10, total: 0, unlimited: true, budgetKind: "tokens" },
      },
    });
    expect(rows[0]).toMatchObject({ name: "Credits (today)", budgetKind: "local-cap" });
    expect(filterQuotasForCard("volceapi", rows).map((row) => row.name)).toEqual(["Credits (today)"]);
    expect(isDepletedQuotaRow(rows[0])).toBe(false);
    expect(isDepletedQuotaRow({ used: 99, total: 100 })).toBe(true);
  });
});
