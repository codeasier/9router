import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

const modelsMocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/models", () => modelsMocks);
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const { resolveConnectionProxyConfig, toCredentialProxyFields } = await import("../../src/lib/network/connectionProxy.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const POOL_7895 = {
  id: "a37a0712-8033-4683-892a-0ecbc8d478a1",
  isActive: true,
  proxyUrl: "http://172.17.0.1:7895/",
  noProxy: "",
  type: "http",
  strictProxy: true,
};

describe("toCredentialProxyFields", () => {
  it("keeps strictProxy from the resolved pool", () => {
    expect(toCredentialProxyFields({
      connectionProxyEnabled: true,
      connectionProxyUrl: POOL_7895.proxyUrl,
      connectionNoProxy: "",
      proxyPoolId: POOL_7895.id,
      vercelRelayUrl: "",
      strictProxy: true,
    })).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: POOL_7895.proxyUrl,
      connectionNoProxy: "",
      connectionProxyPoolId: POOL_7895.id,
      vercelRelayUrl: "",
      strictProxy: true,
    });
  });

  it("defaults missing strictProxy to false", () => {
    expect(toCredentialProxyFields({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local",
    }).strictProxy).toBe(false);
  });
});

describe("resolveConnectionProxyConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces pool strictProxy=true", async () => {
    modelsMocks.getProxyPoolById.mockResolvedValue(POOL_7895);
    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: POOL_7895.id });
    expect(resolved.source).toBe("pool");
    expect(resolved.connectionProxyEnabled).toBe(true);
    expect(resolved.connectionProxyUrl).toBe(POOL_7895.proxyUrl);
    expect(resolved.strictProxy).toBe(true);
  });
});

describe("getProviderCredentials proxy fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    modelsMocks.getProxyPoolById.mockResolvedValue(POOL_7895);
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "codex-1",
      provider: "codex",
      isActive: true,
      displayName: "qyong2026@gmail.com",
      providerSpecificData: { proxyPoolId: POOL_7895.id },
    }]);
  });

  it("copies strictProxy onto credentials used by chat", async () => {
    const credentials = await getProviderCredentials("codex");
    expect(credentials.providerSpecificData.connectionProxyEnabled).toBe(true);
    expect(credentials.providerSpecificData.connectionProxyUrl).toBe(POOL_7895.proxyUrl);
    expect(credentials.providerSpecificData.connectionProxyPoolId).toBe(POOL_7895.id);
    expect(credentials.providerSpecificData.strictProxy).toBe(true);
  });
});

describe("proxyAwareFetch strictProxy", () => {
  it("fails closed when the configured proxy is unreachable", async () => {
    await expect(proxyAwareFetch("http://127.0.0.1:65535/", { method: "GET" }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:1",
      strictProxy: true,
    })).rejects.toThrow(/Proxy required but failed \(strictProxy=true\)/);
  });
});
