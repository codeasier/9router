import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { createRequestDeadline } from "../../open-sse/utils/requestDeadline.js";

const contexts = [];
const encoder = new TextEncoder();
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const event = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const prefix = event("response.reasoning_summary_text.delta", { delta: "thinking" });
function context(options = {}) {
  const value = createRequestDeadline(options);
  contexts.push(value);
  return value;
}
function args(requestDeadline, extra = {}) {
  return { model: "gpt-test", body: { model: "gpt-test", input: "hello" }, stream: true, credentials: {}, requestDeadline, ...extra };
}
function sse(text, cancel = vi.fn(), close = false) {
  return new Response(new ReadableStream({
    start(controller) { if (text) controller.enqueue(encoder.encode(text)); if (close) controller.close(); },
    cancel,
  }), { headers: { "Content-Type": "text/event-stream" } });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); fetchMock.mockReset(); });
afterEach(() => { contexts.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Codex first-response budget", () => {
  it("accepts 90s prefill once instead of restarting at 60s", async () => {
    const requestDeadline = context({ timeoutMs: 110000 });
    fetchMock.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(sse(prefix, vi.fn(), true)), 90000)));
    const pending = new CodexExecutor().execute(args(requestDeadline));
    await vi.advanceTimersByTimeAsync(90000);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestDeadline.signal.aborted).toBe(false);
    expect(requestDeadline.remainingMs()).toBe(20000);
    requestDeadline.finish();
    await expect(result.response.text()).resolves.toBe(prefix);
  });

  it("ends a non-cooperating never-headers request within 110s with no restart", async () => {
    const requestDeadline = context({ timeoutMs: 110000 });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = outcome(new CodexExecutor().execute(args(requestDeadline)));
    await vi.advanceTimersByTimeAsync(110000);
    expect((await pending).error.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts header wait and stalled SSE peek against the same deadline", async () => {
    const requestDeadline = context({ timeoutMs: 110000 });
    const cancel = vi.fn(() => new Promise(() => {}));
    const upstream = sse(event("response.created"), cancel);
    fetchMock.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(upstream), 90000)));
    const pending = outcome(new CodexExecutor().execute(args(requestDeadline)));
    await vi.advanceTimersByTimeAsync(110000);
    expect((await pending).error.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(upstream.body.locked).toBe(false);
  });

  it("cancels an early-headers stalled peek immediately", async () => {
    const client = new AbortController();
    const requestDeadline = context({ signal: client.signal });
    const cancel = vi.fn(() => new Promise(() => {}));
    fetchMock.mockResolvedValue(sse(event("response.created"), cancel));
    const pending = outcome(new CodexExecutor().execute(args(requestDeadline)));
    await vi.advanceTimersByTimeAsync(0);
    client.abort("private caller cancellation");
    expect((await pending).error).toMatchObject({ code: "CLIENT_DISCONNECTED", message: "Client disconnected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("replays the prefix exactly and keeps a healthy stream alive after build completion", async () => {
    const requestDeadline = context({ timeoutMs: 100 });
    let upstream;
    const response = new Response(new ReadableStream({ start(controller) {
      upstream = controller;
      controller.enqueue(encoder.encode(prefix));
    } }), { headers: { "Content-Type": "text/event-stream" } });
    fetchMock.mockResolvedValue(response);
    const result = await new CodexExecutor().execute(args(requestDeadline));
    requestDeadline.finish();
    const text = result.response.text();
    await vi.advanceTimersByTimeAsync(10000);
    expect(requestDeadline.signal.aborted).toBe(false);
    const answer = event("response.output_text.delta", { delta: "answer" });
    upstream.enqueue(encoder.encode(answer));
    upstream.close();
    await expect(text).resolves.toBe(prefix + answer);
  });

  it("preserves client cancellation after the peek releases the stream", async () => {
    const client = new AbortController();
    const requestDeadline = context({ signal: client.signal, timeoutMs: 100 });
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(sse(prefix, cancel));
    const result = await new CodexExecutor().execute(args(requestDeadline));
    requestDeadline.finish();
    const reading = outcome(result.response.text());
    client.abort(new Error("client stopped"));
    expect((await reading).error.code).toBe("CLIENT_DISCONNECTED");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not restart after cancellation during SSE overload backoff", async () => {
    const client = new AbortController();
    const requestDeadline = context({ signal: client.signal });
    const discard = vi.fn();
    fetchMock.mockResolvedValue(sse(event("error", { error: { message: "server_is_overloaded" } }), discard));
    const pending = outcome(new CodexExecutor().execute(args(requestDeadline)));
    await vi.advanceTimersByTimeAsync(0);
    expect(discard).toHaveBeenCalledTimes(1);
    client.abort();
    expect((await pending).error.code).toBe("CLIENT_DISCONNECTED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a bounded SSE overload retry when budget remains", async () => {
    const requestDeadline = context({ timeoutMs: 1000 });
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { 503: { attempts: 1, delayMs: 5 } } };
    fetchMock.mockResolvedValueOnce(sse(event("error", { error: { message: "server_is_overloaded" } })))
      .mockResolvedValueOnce(sse(prefix, vi.fn(), true));
    const pending = executor.execute(args(requestDeadline));
    await vi.advanceTimersByTimeAsync(5);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    requestDeadline.finish();
    await expect(result.response.text()).resolves.toBe(prefix);
  });

  it("does not share cancellation state between concurrent calls on a cached executor", async () => {
    const client = new AbortController();
    const firstDeadline = context({ signal: client.signal });
    const secondDeadline = context();
    const executor = new CodexExecutor();
    fetchMock.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(sse(prefix, vi.fn(), true));
    const first = outcome(executor.execute(args(firstDeadline)));
    const second = executor.execute(args(secondDeadline));
    await vi.advanceTimersByTimeAsync(0);
    client.abort();
    expect((await first).error.code).toBe("CLIENT_DISCONNECTED");
    const result = await second;
    expect(secondDeadline.signal.aborted).toBe(false);
    secondDeadline.finish();
    await expect(result.response.text()).resolves.toBe(prefix);
  });
});
