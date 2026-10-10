import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProxyPoolById: vi.fn(), getProviderConnections: vi.fn(), validateApiKey: vi.fn(), updateProviderConnection: vi.fn(), getSettings: vi.fn(), getProxyPools: vi.fn(), send: vi.fn() }));
vi.mock("@/models", () => ({ getProxyPoolById: mocks.getProxyPoolById }));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("undici", () => ({ ProxyAgent: class { constructor({ uri }) { this.uri = uri; } } }));
// Capture only mocked transport in proxyFetch. No sockets or real tokens.
const originalFetch = globalThis.fetch;
globalThis.fetch = mocks.send;
const { proxyAwareFetch, resolveOutboundProxyUrl } = await import("../../open-sse/utils/proxyFetch.js");
globalThis.fetch = originalFetch;
const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const activePool = { id: "bound", isActive: true, proxyUrl: "http://pool.test:8080", strictProxy: true };
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ["HTTPS_PROXY", "https_proxy"]) vi.stubEnv(key, "http://global.test:8080");
  for (const key of ["NO_PROXY", "no_proxy"]) vi.stubEnv(key, "");
  mocks.getSettings.mockResolvedValue({});
  mocks.getProviderConnections.mockResolvedValue([{
    id: "account", isActive: true, provider: "codex", apiKey: "mock-only",
    providerSpecificData: {
      proxyPoolId: "bound", connectionProxyEnabled: true,
      connectionProxyUrl: "http://legacy.test:8080", connectionNoProxy: "*", vercelRelayUrl: "https://relay.test",
    },
  }]);
  mocks.getProxyPoolById.mockResolvedValue(activePool);
  mocks.send.mockResolvedValue(new Response("ok"));
});
afterEach(() => vi.unstubAllEnvs());
async function sendWithCredentials() {
  const credentials = await getProviderCredentials("codex");
  return proxyAwareFetch("https://upstream.test/v1/chat/completions", {}, credentials.providerSpecificData);
}
describe("unavailable explicit bindings fail closed", () => {
  it.each([
    ["missing", null], ["inactive", { ...activePool, isActive: false }],
    ["empty URL", { ...activePool, proxyUrl: "   " }],
    ["inactive relay", { ...activePool, type: "vercel", isActive: false }],
    ["empty relay URL", { ...activePool, type: "cloudflare", proxyUrl: "" }],
  ])("%s sends neither globally nor directly", async (_label, pool) => {
    mocks.getProxyPoolById.mockResolvedValue(pool);
    await expect(sendWithCredentials()).rejects.toThrow("Bound proxy pool is unavailable");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("lookup failures do not return strictProxy=false or leak database details", async () => {
    mocks.getProxyPoolById.mockRejectedValue(new Error("private database location"));
    await expect(sendWithCredentials()).rejects.toThrow(/^Bound proxy pool lookup failed$/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("an active strict pool never retries transport failure directly", async () => {
    mocks.send.mockRejectedValue(new Error("mock proxy down"));
    await expect(sendWithCredentials()).rejects.toThrow("strictProxy=true");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][1].dispatcher.uri).toBe(activePool.proxyUrl);
  });
  it.each([{}, { proxyPoolId: "__none__" }])("retains global proxy behavior when genuinely unbound: %j", async data => {
    const resolved = await resolveConnectionProxyConfig(data);
    expect(resolved.source).toBe("none");
    expect(mocks.getProxyPoolById).not.toHaveBeenCalled();
    expect(resolveOutboundProxyUrl("https://upstream.test", resolved)).toBe("http://global.test:8080");
    await proxyAwareFetch("https://upstream.test", {}, resolved);
    expect(mocks.send.mock.calls[0][1].dispatcher.uri).toBe("http://global.test:8080");
  });
  it("preserves active pool opt-in fallback and noProxy settings", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ ...activePool, strictProxy: false, noProxy: "upstream.test" });
    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: "bound" });
    expect(resolved.strictProxy).toBe(false);
    expect(resolved.connectionNoProxy).toBe("upstream.test");
    expect(resolveOutboundProxyUrl("https://upstream.test", resolved)).toBe("http://global.test:8080");
  });
  it("keeps legacy configuration when no pool is bound", async () => {
    const resolved = await resolveConnectionProxyConfig({ connectionProxyEnabled: true, connectionProxyUrl: "http://legacy.test:8080" });
    expect(resolved.source).toBe("legacy");
    expect(resolveOutboundProxyUrl("https://upstream.test", resolved)).toBe("http://legacy.test:8080");
  });
});
