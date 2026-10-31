import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestAbortError } from "../../open-sse/utils/requestDeadline.js";

// No real dispatcher/socket is created; exercise routing and abort classification.
vi.mock("undici", () => ({ Agent: class Agent {}, ProxyAgent: class ProxyAgent {} }));
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
async function load(fetchMock) {
  vi.resetModules();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(key, "");
  vi.stubGlobal("fetch", fetchMock);
  return (await import("../../open-sse/utils/proxyFetch.js")).proxyAwareFetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("proxy cancellation never changes transport policy", () => {
  it.each([
    ["https://api.example.invalid/chat", false],
    ["https://api.example.invalid/chat", true],
    ["https://api2.cursor.sh/chat", false],
    ["https://api2.cursor.sh/chat", true],
  ])("does not fall back or wrap the abort on %s strict=%s", async (url, strictProxy) => {
    const controller = new AbortController();
    const reason = createRequestAbortError("UPSTREAM_HEADERS_TIMEOUT");
    const fetchMock = vi.fn(async () => { controller.abort(reason); throw new Error("transport wrapped cancellation"); });
    const proxyAwareFetch = await load(fetchMock);
    await expect(proxyAwareFetch(url, { signal: controller.signal }, {
      enabled: true, url: "http://proxy.invalid:3128", strictProxy,
    })).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("arbitrary cancellation"), "cancel string"])("uses signal state rather than error.name", async reason => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => { controller.abort(reason); throw new TypeError("fetch failed"); });
    const proxyAwareFetch = await load(fetchMock);
    await expect(proxyAwareFetch("https://api.example.invalid/chat", { signal: controller.signal }, {
      enabled: true, url: "http://proxy.invalid:3128", strictProxy: false,
    })).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a canceled non-cooperating proxy fetch and cancels a late body", async () => {
    const controller = new AbortController();
    let resolve;
    const started = new Promise(done => {
      resolve = done;
    });
    let finish;
    const fetchMock = vi.fn(() => { resolve(); return new Promise(done => { finish = done; }); });
    const proxyAwareFetch = await load(fetchMock);
    const pending = outcome(proxyAwareFetch("https://api.example.invalid/chat", { signal: controller.signal }, {
      enabled: true, url: "http://proxy.invalid:3128", strictProxy: true,
    }));
    await started;
    controller.abort(createRequestAbortError("CLIENT_DISCONNECTED"));
    expect((await pending).error.code).toBe("CLIENT_DISCONNECTED");
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    // The result passes through the transport and routing promises before cleanup.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("never replays an underlying headers timeout with strict=%s", async strictProxy => {
    const underlying = Object.assign(new Error("headers timed out"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: underlying }));
    const proxyAwareFetch = await load(fetchMock);
    const controller = new AbortController();
    await expect(proxyAwareFetch("https://api.example.invalid/chat", { signal: controller.signal }, {
      enabled: true, url: "http://proxy.invalid:3128", strictProxy,
    })).rejects.toMatchObject({ code: "UPSTREAM_HEADERS_TIMEOUT" });
    expect(controller.signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not invoke fetch at all for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort("canceled");
    const fetchMock = vi.fn();
    const proxyAwareFetch = await load(fetchMock);
    await expect(proxyAwareFetch("https://api.example.invalid/chat", { signal: controller.signal })).rejects.toBe("canceled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not invoke an insecure TLS retry after signal cancellation", async () => {
    const controller = new AbortController();
    const reason = createRequestAbortError("CHAT_BUILD_TIMEOUT");
    const fetchMock = vi.fn(async () => {
      controller.abort(reason);
      throw Object.assign(new Error("certificate error"), { code: "CERT_HAS_EXPIRED" });
    });
    const proxyAwareFetch = await load(fetchMock);
    await expect(proxyAwareFetch("https://api.example.invalid/chat", { signal: controller.signal })).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
