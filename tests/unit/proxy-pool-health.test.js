import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(), updateProxyPool: vi.fn(),
  testProxyUrl: vi.fn(), relayFetch: vi.fn(),
}));
vi.mock("@/models", () => mocks);
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxyUrl }));
vi.mock("undici", () => ({ fetch: mocks.relayFetch }));
const { POST } = await import("../../src/app/api/proxy-pools/[id]/test/route.js");

function pool(id, isActive, type = "http") {
  return { id, isActive, type, proxyUrl: "http://proxy.test", strictProxy: true };
}
let pools;
async function probe(id) {
  return POST(new Request(`http://localhost/api/proxy-pools/${id}/test`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  pools = new Map();
  mocks.getProxyPoolById.mockImplementation(async id => ({ ...pools.get(id) }));
  // Like the repository transaction, merge health fields into the current row,
  // rather than the stale snapshot returned before the probe began.
  mocks.updateProxyPool.mockImplementation(async (id, patch) => {
    pools.set(id, { ...pools.get(id), ...patch });
  });
});

describe("proxy pool probes preserve administrative state", () => {
  it.each(["http", "vercel", "cloudflare", "deno"])("%s failures keep enabled pools enabled, successes keep disabled pools disabled", async type => {
    pools.set("enabled", pool("enabled", true, type));
    pools.set("disabled", pool("disabled", false, type));
    const probeMock = type === "http" ? mocks.testProxyUrl : mocks.relayFetch;
    probeMock.mockResolvedValueOnce({ ok: false, status: 502 }).mockResolvedValueOnce({ ok: true, status: 200 });
    expect((await probe("enabled")).status).toBe(200);
    expect((await probe("disabled")).status).toBe(200);
    expect(pools.get("enabled")).toMatchObject({ isActive: true, testStatus: "error" });
    expect(pools.get("disabled")).toMatchObject({ isActive: false, testStatus: "active", lastError: null });
    for (const [, patch] of mocks.updateProxyPool.mock.calls) {
      expect(patch).not.toHaveProperty("isActive");
      expect(patch.lastTestedAt).toEqual(expect.any(String));
    }
  });

  it.each([true, false])("does not overwrite a concurrent toggle from %s", async initial => {
    pools.set("pool", pool("pool", initial));
    mocks.testProxyUrl.mockImplementation(async () => {
      pools.get("pool").isActive = !initial;
      return { ok: initial, status: initial ? 200 : 502 };
    });
    await probe("pool");
    expect(pools.get("pool").isActive).toBe(!initial);
  });

  it("canceling the batch disable confirmation leaves failed pools enabled", async () => {
    pools.set("a", pool("a", true));
    pools.set("b", pool("b", true));
    mocks.testProxyUrl.mockResolvedValue({ ok: false, status: 502 });
    const fetch = vi.fn(async url => probe(url.split("/")[3]));
    let confirmation;
    // Execute the dashboard's actual batch handler without rendering unrelated
    // dashboard components. Leaving onConfirm uncalled models Cancel.
    const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/proxy-pools/page.js", import.meta.url), "utf8");
    const handler = source.split("const handleHealthCheck = async () => {")[1].split("\n  // Cleanup selectedIds")[0];
    const run = new Function("selectedIds", "proxyPools", "fetch", "setHealthChecking", "setHealthProgress", "fetchProxyPools", "setConfirmState", "setBulkBusy", "notify", `return (async () => {${handler.slice(0, handler.lastIndexOf("};"))}})();`);
    await run([], [...pools.values()], fetch, vi.fn(), vi.fn(), vi.fn(), value => { confirmation = value; }, vi.fn(), { success: vi.fn() });
    expect(confirmation.title).toBe("Disable Dead Proxies");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect([...pools.values()].every(p => p.isActive)).toBe(true);
    expect([...pools.values()].every(p => p.testStatus === "error")).toBe(true);
  });
});
