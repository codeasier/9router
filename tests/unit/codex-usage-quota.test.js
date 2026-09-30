import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexUsage } from "../../open-sse/services/usage/codex.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { filterQuotasForCard, getQuotaVisibilityKey, parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const resetAt = 1791046786;
const window = (used, seconds) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: resetAt });
function respond(data) {
  proxyAwareFetch.mockResolvedValue({ ok: true, status: 200, json: async () => data });
}

beforeEach(() => {
  vi.clearAllMocks();
  respond({ plan_type: "pro", rate_limit: { primary_window: window(34, 604800), secondary_window: null } });
});

describe("Codex usage account binding", () => {
  it.each([
    [{ workspaceId: "workspace", chatgptAccountId: "chatgpt", accountId: "account" }, "workspace"],
    [{ chatgptAccountId: "chatgpt", accountId: "account" }, "chatgpt"],
    [{ accountId: "account" }, "account"],
  ])("binds usage to the same identity priority as generation: %j", async (providerData, accountId) => {
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test", strictProxy: false };
    await getCodexUsage("test-token", proxyOptions, providerData);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/wham/usage"),
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({
        Authorization: "Bearer test-token", "ChatGPT-Account-ID": accountId,
      }) }),
      proxyOptions,
    );
  });

  it("passes stored account identity through provider dispatch", async () => {
    const proxyOptions = { strictProxy: false };
    await getUsageForProvider({
      provider: "codex", accessToken: "test-token", providerSpecificData: { chatgptAccountId: "selected-account" },
    }, proxyOptions);
    expect(proxyAwareFetch.mock.calls[0][1].headers["ChatGPT-Account-ID"]).toBe("selected-account");
    expect(proxyAwareFetch.mock.calls[0][2]).toBe(proxyOptions);
  });

  it("keeps the legacy token/proxy-only call compatible without inventing an identity", async () => {
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test" };
    await getCodexUsage("test-token", proxyOptions);
    expect(proxyAwareFetch.mock.calls[0][1].headers).not.toHaveProperty("ChatGPT-Account-ID");
    expect(proxyAwareFetch.mock.calls[0][2]).toBe(proxyOptions);
  });

  it("reproduces the 31% versus 66% discrepancy and fixes it through dispatch", async () => {
    proxyAwareFetch.mockImplementation(async (_url, options) => ({
      ok: true,
      json: async () => ({ plan_type: "pro", rate_limit: {
        primary_window: window(options.headers["ChatGPT-Account-ID"] === "selected-account" ? 34 : 69, 604800),
      } }),
    }));
    const usage = await getUsageForProvider({
      provider: "codex", accessToken: "test-token", providerSpecificData: { chatgptAccountId: "selected-account" },
    });
    expect(parseQuotaData("codex", usage)).toEqual([
      expect.objectContaining({ name: "Weekly", used: 34, remaining: 66, windowSeconds: 604800 }),
    ]);
  });

  it("never includes credentials or account identity in the normalized usage result", async () => {
    const connection = {
      provider: "codex", accessToken: "sentinel-access-token", refreshToken: "sentinel-refresh-token",
      providerSpecificData: { chatgptAccountId: "sentinel-account-id" },
    };
    respond({ account_id: "sentinel-account-id", rate_limit: { primary_window: window(34, 604800) } });
    const usage = await getUsageForProvider(connection, { connectionProxyUrl: "http://user:sentinel-proxy-password@proxy.test" });
    const serialized = JSON.stringify(usage);
    for (const secret of ["sentinel-access-token", "sentinel-refresh-token", "sentinel-account-id", "sentinel-proxy-password"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("preserves the existing unavailable-API response", async () => {
    proxyAwareFetch.mockResolvedValue({ ok: false, status: 401 });
    expect(await getCodexUsage("test-token", null, { chatgptAccountId: "account" })).toEqual({
      message: "Codex connected. Usage API temporarily unavailable (401).",
    });
  });
});

describe("Codex quota window duration", () => {
  it("classifies a single seven-day primary as weekly, not a five-hour session", async () => {
    const usage = await getCodexUsage("test-token");
    expect(usage.quotas).not.toHaveProperty("session");
    expect(usage.quotas.weekly).toMatchObject({ used: 34, total: 100, remaining: 66, windowSeconds: 604800 });
    expect(parseQuotaData("codex", usage)[0]).toMatchObject({ name: "Weekly", remaining: 66 });
  });

  it.each([
    [18000, "session", "5h"],
    [86400, "daily", "Daily"],
    [604800, "weekly", "Weekly"],
    [2592000, "monthly", "Monthly"],
  ])("classifies %i-second primary as %s", async (seconds, type, label) => {
    respond({ rate_limit: { primary_window: window(12, seconds) } });
    const usage = await getCodexUsage("test-token");
    expect(usage.quotas[type]).toMatchObject({ windowSeconds: seconds, remaining: 88 });
    expect(parseQuotaData("codex", usage)[0]).toMatchObject({ name: label, windowSeconds: seconds });
  });

  it("uses duration when primary and secondary are reversed", async () => {
    respond({ rate_limit: { primary_window: window(34, 604800), secondary_window: window(10, 18000) } });
    const usage = await getCodexUsage("test-token");
    expect(usage.quotas.weekly.used).toBe(34);
    expect(usage.quotas.session.used).toBe(10);
  });

  it("preserves monthly and weekly windows together without overwriting either", async () => {
    respond({ rate_limit: { primary_window: window(25, 2592000), secondary_window: window(34, 604800) } });
    const usage = await getCodexUsage("test-token");
    expect(parseQuotaData("codex", usage).map(row => [row.name, row.used])).toEqual([["Monthly", 25], ["Weekly", 34]]);
  });

  it("keeps both windows even when upstream returns equal durations", async () => {
    respond({ rate_limit: { primary_window: window(25, 604800), secondary_window: window(34, 604800) } });
    const usage = await getCodexUsage("test-token");
    expect(Object.values(usage.quotas).map(quota => quota.used)).toEqual([25, 34]);
    expect(parseQuotaData("codex", usage).map(row => row.name)).toEqual(["Weekly", "Weekly"]);
  });

  it("labels a duration-less secondary after a weekly primary without leaking its collision key", async () => {
    respond({ rate_limit: {
      primary_window: window(25, 604800), secondary_window: { used_percent: 34, reset_at: resetAt },
    } });
    const rows = parseQuotaData("codex", await getCodexUsage("test-token"));
    expect(rows.map(row => row.name)).toEqual(["Weekly", "Weekly"]);
  });

  it("keeps equal-duration rows independently hideable", async () => {
    respond({ rate_limit: { primary_window: window(25, 604800), secondary_window: window(34, 604800) } });
    const rows = parseQuotaData("codex", await getCodexUsage("test-token"));
    const keys = rows.map(getQuotaVisibilityKey);
    expect(new Set(keys).size).toBe(2);
    const visible = filterQuotasForCard("codex", rows, { codex: { hidden: [keys[0]] } });
    expect(visible).toEqual([rows[1]]);
  });

  it("preserves legacy visibility keys for single windows", async () => {
    const rows = parseQuotaData("codex", await getCodexUsage("test-token"));
    expect(getQuotaVisibilityKey(rows[0])).toBe("Weekly");
    expect(filterQuotasForCard("codex", rows, { codex: { hidden: ["Weekly"] } })).toEqual([]);
  });

  it("uses duration metadata to correct legacy positional UI rows", () => {
    const rows = parseQuotaData("codex", { quotas: {
      session: { used: 34, total: 100, remaining: 66, windowSeconds: 604800 },
    } });
    expect(rows[0].name).toBe("Weekly");
  });

  it("keeps positional fallback only when duration is absent or invalid", async () => {
    respond({ rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 0, reset_at: resetAt },
      secondary_window: { used_percent: 20, limit_window_seconds: "invalid", reset_at: resetAt },
    } });
    const usage = await getCodexUsage("test-token");
    expect(usage.quotas.session).toMatchObject({ remaining: 90, windowSeconds: null });
    expect(usage.quotas.weekly).toMatchObject({ remaining: 80, windowSeconds: null });
    expect(parseQuotaData("codex", usage).map(row => row.name)).toEqual(["5h", "Weekly"]);
  });

  it.each(["limit_window_seconds", "window_seconds", "windowSeconds"])("accepts numeric duration in %s", async key => {
    respond({ rate_limit: { primary_window: { used_percent: 34, [key]: "604800", reset_at: resetAt } } });
    const usage = await getCodexUsage("test-token");
    expect(usage.quotas.weekly).toMatchObject({ windowSeconds: 604800, remaining: 66 });
  });

  it("does not label an unfamiliar primary duration as five hours", async () => {
    respond({ rate_limit: { primary_window: window(12, 43200) } });
    const usage = await getCodexUsage("test-token");
    expect(usage.quotas).not.toHaveProperty("session");
    const row = parseQuotaData("codex", usage)[0];
    expect(row.name).not.toBe("5h");
    expect(row.windowSeconds).toBe(43200);
    expect(row.remaining).toBe(88);
  });

  it("classifies normal, review and Spark quotas independently", async () => {
    respond({
      rate_limit: { primary_window: window(34, 604800) },
      code_review_rate_limit: { primary_window: window(8, 2592000), secondary_window: window(10, 604800) },
      spark_rate_limit: { primary_window: window(12, 18000), secondary_window: window(25, 604800) },
    });
    const rows = parseQuotaData("codex", await getCodexUsage("test-token"));
    expect(rows.map(row => row.name)).toEqual(["Weekly", "Review (Monthly)", "Review (Weekly)", "Spark (5h)", "Spark (Weekly)"]);
  });
});
