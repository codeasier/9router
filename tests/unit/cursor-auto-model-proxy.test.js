import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connectHttp2: vi.fn() }));
vi.mock("../../open-sse/utils/http2Connect.js", () => ({
  assertHttp2ProxyPolicy: vi.fn(),
  connectHttp2: mocks.connectHttp2,
}));

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { clearCursorModelCache } from "../../open-sse/services/cursorModels.js";

const proxyOptions = {
  strictProxy: true,
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://bound.invalid:8080",
  proxyPoolId: "bound",
};

beforeEach(() => {
  vi.clearAllMocks();
  clearCursorModelCache();
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    vi.stubEnv(name, "");
  }
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL_FETCH_BLOCKED"); }));
  // Stop at the catalog's transport boundary; no actual socket is opened.
  mocks.connectHttp2.mockRejectedValue(new Error("MOCK_NETWORK_STOP"));
});

afterEach(() => {
  clearCursorModelCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function executeUntilRun(model) {
  const executor = new CursorExecutor();
  executor.openAgentHttp2Stream = vi.fn().mockRejectedValue(new Error("STOP_RUN"));
  await expect(executor.executeAgent({
    model,
    body: { messages: [{ role: "user", content: "mock" }] },
    stream: false,
    credentials: { accessToken: "mock-only", providerSpecificData: { machineId: "a".repeat(64) } },
    proxyOptions,
  })).rejects.toThrow("STOP_RUN");
}

describe("Cursor Auto retains the bound proxy for catalog lookup", () => {
  it.each(["default", "auto"])("%s forwards account proxy to the catalog HTTP/2 request", async (model) => {
    await executeUntilRun(model);
    expect(mocks.connectHttp2).toHaveBeenCalledWith(
      expect.stringContaining("GetUsableModels"),
      expect.objectContaining({ proxyUrl: proxyOptions.connectionProxyUrl }),
    );
  });

  it("does not add a catalog request for an explicit model", async () => {
    await executeUntilRun("claude-4.6-opus");
    expect(mocks.connectHttp2).not.toHaveBeenCalled();
  });
});
