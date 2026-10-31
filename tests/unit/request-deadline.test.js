import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelResponseBody, createRequestAbortError, createRequestDeadline,
  finalizeResponseDeadline, isRequestAbortError,
} from "../../open-sse/utils/requestDeadline.js";

const deadlines = [];
function deadline(options = {}) {
  const value = createRequestDeadline(options);
  deadlines.push(value);
  return value;
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => {
  deadlines.splice(0).forEach(value => value.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("request-scoped first-response deadline", () => {
  it("uses a safe request correlation id and request-local attempt counter", () => {
    const first = deadline({ requestId: "fixture.panel1" });
    const second = deadline({ requestId: "https://private.invalid/?credential=secret" });
    expect(first.requestId).toBe("fixture.panel1");
    expect(second.requestId).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(second.requestId).not.toContain("secret");
    expect(first.nextAttempt()).toBe(1);
    expect(first.nextAttempt()).toBe(2);
    expect(second.nextAttempt()).toBe(1);
  });

  it("bounds an operation that ignores cancellation", async () => {
    const context = deadline({ timeoutMs: 100 });
    const pending = outcome(context.run(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).error).toMatchObject({ code: "CHAT_BUILD_TIMEOUT" });
    expect(context.signal.aborted).toBe(true);
  });

  it("uses one shrinking budget across preparation and backoff", async () => {
    const context = deadline({ timeoutMs: 100 });
    const first = context.sleep(60);
    await vi.advanceTimersByTimeAsync(60);
    await first;
    expect(context.remainingMs()).toBe(40);
    const second = outcome(context.sleep(60));
    await vi.advanceTimersByTimeAsync(40);
    expect((await second).error.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new Error("private detail"), "private detail"])("normalizes incoming cancellation without exposing %s", async reason => {
    const client = new AbortController();
    const context = deadline({ signal: client.signal });
    const pending = outcome(context.run(() => new Promise(() => {})));
    client.abort(reason);
    const { error } = await pending;
    expect(error).toMatchObject({ name: "AbortError", code: "CLIENT_DISCONNECTED", message: "Client disconnected" });
    expect(error.message).not.toContain("private");
  });

  it("does not invoke an operation for an already-aborted client", async () => {
    const client = new AbortController();
    client.abort();
    const context = deadline({ signal: client.signal });
    const operation = vi.fn();
    await expect(context.run(operation)).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("cancels a successful response that arrives after deadline rejection", async () => {
    const context = deadline({ timeoutMs: 10 });
    let resolve;
    const pending = outcome(context.run(() => new Promise(done => { resolve = done; }), cancelResponseBody));
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending).error.code).toBe("CHAT_BUILD_TIMEOUT");
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("checks wall-clock expiry on fulfillment before timers get a turn", async () => {
    const context = deadline({ timeoutMs: 100 });
    const disposeLate = vi.fn();
    const pending = context.run(() => { vi.setSystemTime(101); return "late"; }, disposeLate);
    await expect(pending).rejects.toMatchObject({ code: "CHAT_BUILD_TIMEOUT" });
    expect(disposeLate).toHaveBeenCalledWith("late");
  });

  it("preserves the first safe typed cause when sibling work is aborted", () => {
    const context = deadline();
    context.abort(createRequestAbortError("UPSTREAM_HEADERS_TIMEOUT"));
    context.abort(createRequestAbortError("CLIENT_DISCONNECTED"));
    expect(context.signal.reason.code).toBe("UPSTREAM_HEADERS_TIMEOUT");
    expect(isRequestAbortError(context.signal.reason)).toBe(true);
    expect(isRequestAbortError(new Error("unrelated"))).toBe(false);
  });

  it("finish clears the build timer but keeps a long stream cancellable", async () => {
    const client = new AbortController();
    const context = deadline({ signal: client.signal, timeoutMs: 100 });
    const cancel = vi.fn(() => new Promise(() => {}));
    const response = finalizeResponseDeadline(new Response(new ReadableStream({ cancel })), context);
    const reader = response.body.getReader();
    const read = outcome(reader.read());
    await vi.advanceTimersByTimeAsync(1000);
    expect(context.signal.aborted).toBe(false);
    expect(context.remainingMs()).toBe(Infinity);
    client.abort(new Error("private reason"));
    expect((await read).error.code).toBe("CLIENT_DISCONNECTED");
    expect(cancel).toHaveBeenCalledTimes(1);
    reader.releaseLock();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumer cancellation aborts remaining work and releases the upstream lock", async () => {
    const context = deadline({ timeoutMs: 100 });
    const original = new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }));
    const wrapped = finalizeResponseDeadline(original, context);
    await wrapped.body.cancel("raw private reason");
    expect(context.signal.reason).toMatchObject({ code: "CLIENT_DISCONNECTED", message: "Client disconnected" });
    expect(original.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes the incoming listener after a complete response", async () => {
    const client = new AbortController();
    const remove = vi.spyOn(client.signal, "removeEventListener");
    const context = deadline({ signal: client.signal });
    const response = finalizeResponseDeadline(new Response("complete"), context);
    await expect(response.text()).resolves.toBe("complete");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "", "0", "-1", "not-a-number"])("falls back to 110 seconds for invalid environment value %s", async value => {
    if (value === undefined) vi.stubEnv("CHAT_BUILD_TIMEOUT_MS", undefined);
    else vi.stubEnv("CHAT_BUILD_TIMEOUT_MS", value);
    vi.resetModules();
    const config = await import("../../open-sse/config/runtimeConfig.js");
    expect(config.CHAT_BUILD_TIMEOUT_MS).toBe(110000);
  });

  it("allows a positive deployment budget override", async () => {
    vi.stubEnv("CHAT_BUILD_TIMEOUT_MS", "95000");
    vi.resetModules();
    const config = await import("../../open-sse/config/runtimeConfig.js");
    expect(config.CHAT_BUILD_TIMEOUT_MS).toBe(95000);
  });
});
