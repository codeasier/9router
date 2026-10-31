import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { createRequestDeadline } from "../../open-sse/utils/requestDeadline.js";

const contexts = [];
const baseArgs = { model: "test", body: {}, stream: true, credentials: { apiKey: "test-only" } };
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
function context(options) {
  const value = createRequestDeadline(options);
  contexts.push(value);
  return value;
}
function executor(extra = {}) { return new BaseExecutor("test", { baseUrl: "https://upstream.invalid/chat", ...extra }); }
function response(status = 200, cancel = vi.fn()) {
  return new Response(new ReadableStream({ cancel }), { status });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); fetchMock.mockReset(); });
afterEach(() => { contexts.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("BaseExecutor bounded transport", () => {
  it("ends a never-headers request at 60s once, without retry or URL fallback", async () => {
    const requestDeadline = context({ timeoutMs: 110000 });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = outcome(executor({ baseUrls: ["https://a.invalid", "https://b.invalid"] }).execute({ ...baseArgs, requestDeadline }));
    await vi.advanceTimersByTimeAsync(60000);
    expect((await pending).error.code).toBe("UPSTREAM_HEADERS_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("clamps the existing provider timeout hook to the shared remaining budget", async () => {
    const requestDeadline = context({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(60);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = outcome(executor({ timeoutMs: 1000 }).execute({ ...baseArgs, requestDeadline }));
    await vi.advanceTimersByTimeAsync(40);
    expect((await pending).error.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a shorter explicit provider timeout", async () => {
    const requestDeadline = context({ timeoutMs: 100 });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = outcome(executor({ timeoutMs: 20 }).execute({ ...baseArgs, requestDeadline }));
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).error.code).toBe("UPSTREAM_HEADERS_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("private client reason"), "client reason"])("cancels a non-cooperating fetch for any signal reason", async reason => {
    const client = new AbortController();
    const requestDeadline = context({ signal: client.signal });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = outcome(executor().execute({ ...baseArgs, requestDeadline, signal: client.signal }));
    client.abort(reason);
    expect((await pending).error.code).toBe("CLIENT_DISCONNECTED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards a late successful response after header timeout", async () => {
    let resolve;
    const requestDeadline = context({ timeoutMs: 100 });
    fetchMock.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = outcome(executor({ timeoutMs: 20 }).execute({ ...baseArgs, requestDeadline }));
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).error.code).toBe("UPSTREAM_HEADERS_TIMEOUT");
    const cancel = vi.fn();
    resolve(response(200, cancel));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels backoff immediately without starting another attempt", async () => {
    const client = new AbortController();
    const requestDeadline = context({ signal: client.signal });
    const discard = vi.fn();
    fetchMock.mockResolvedValueOnce(response(503, discard));
    const pending = outcome(executor().execute({ ...baseArgs, requestDeadline }));
    await vi.advanceTimersByTimeAsync(0);
    expect(discard).toHaveBeenCalledTimes(1);
    client.abort();
    expect((await pending).error.code).toBe("CLIENT_DISCONNECTED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled response-reading retry hook", async () => {
    const requestDeadline = context({ timeoutMs: 100 });
    const discard = vi.fn();
    const ex = executor();
    ex.computeRetryDelay = vi.fn(() => new Promise(() => {}));
    fetchMock.mockResolvedValueOnce(response(503, discard));
    const pending = outcome(ex.execute({ ...baseArgs, requestDeadline }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).error.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503])("retains bounded HTTP %s retries and cancels discarded bodies", async status => {
    const requestDeadline = context({ timeoutMs: 1000 });
    const discard = vi.fn();
    fetchMock.mockResolvedValueOnce(response(status, discard)).mockResolvedValueOnce(new Response("ok"));
    const pending = executor({ retry: { [status]: { attempts: 1, delayMs: 5 } } }).execute({ ...baseArgs, requestDeadline });
    await vi.advanceTimersByTimeAsync(5);
    const result = await pending;
    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("retains HTTP 429 URL fallback and cancels the rejected body", async () => {
    const requestDeadline = context({ timeoutMs: 1000 });
    const discard = vi.fn();
    fetchMock.mockResolvedValueOnce(response(429, discard)).mockResolvedValueOnce(new Response("ok"));
    const result = await executor({ baseUrls: ["https://a.invalid", "https://b.invalid"] }).execute({ ...baseArgs, requestDeadline });
    expect(result.url).toBe("https://b.invalid");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("correlates retries within one request while measuring each attempt separately", async () => {
    const requestDeadline = context({ timeoutMs: 1000, requestId: "request-fixture" });
    const log = { info: vi.fn() };
    fetchMock.mockResolvedValueOnce(response(503)).mockResolvedValueOnce(new Response("ok"));
    const pending = executor({ retry: { 503: { attempts: 1, delayMs: 5 } } }).execute({ ...baseArgs, requestDeadline, log });
    await vi.advanceTimersByTimeAsync(5);
    await pending;
    const starts = log.info.mock.calls.map(([, message]) => message).filter(message => message.includes("phase=fetch_start"));
    expect(starts).toHaveLength(2);
    expect(starts[0]).toContain("request=request-fixture provider=TEST attempt=1 total_elapsed=0ms attempt_elapsed=0ms");
    expect(starts[1]).toContain("request=request-fixture provider=TEST attempt=2 total_elapsed=5ms attempt_elapsed=0ms");
  });

  it("keeps ordinary-info diagnostics free of endpoints, credentials, bodies and raw causes", async () => {
    const requestDeadline = context({ timeoutMs: 100 });
    const log = { info: vi.fn(), debug: vi.fn() };
    fetchMock.mockRejectedValue(new Error("private-error-secret"));
    await expect(executor({ retry: { 502: { attempts: 0 } } }).execute({
      ...baseArgs, body: { secret: "private-body-secret" }, requestDeadline, log,
      proxyOptions: { enabled: true, url: "http://private-proxy-secret" },
    })).rejects.toThrow("private-error-secret");
    const output = JSON.stringify(log.info.mock.calls);
    for (const field of ["request=", "attempt=1", "total_elapsed=", "attempt_elapsed=", "remaining=", "phase=", "proxy=", "cause=network_error"]) expect(output).toContain(field);
    for (const secret of ["upstream.invalid", "test-only", "private-error-secret", "private-body-secret", "private-proxy-secret"]) expect(output).not.toContain(secret);
  });
});
