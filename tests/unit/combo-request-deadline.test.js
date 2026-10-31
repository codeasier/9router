import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";
import { setStickyComboModel, clearStickyComboSession } from "../../open-sse/services/systemoneRouter.js";
import { createRequestDeadline, createRequestAbortError } from "../../open-sse/utils/requestDeadline.js";
import { BACKOFF_CONFIG } from "../../open-sse/config/errorConfig.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const models = ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"];
const body = { messages: [{ role: "user", content: "hi" }], stream: true };
const deadlines = [];
const encoder = new TextEncoder();
const ROLE = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
const CONTENT = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function deadline(timeoutMs = 110_000) {
  const client = new AbortController();
  const requestDeadline = createRequestDeadline({ signal: client.signal, timeoutMs });
  deadlines.push(requestDeadline);
  return { client, requestDeadline };
}

function jsonResponse(value, status = 200) {
  const response = new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  // Keep read-only JSON peeks deterministic with fake timers; the final body is real.
  vi.spyOn(response, "clone").mockReturnValue({ json: async () => value });
  return response;
}

const errorResponse = (status, message) => jsonResponse({ error: { message } }, status);
const successResponse = () => jsonResponse({ choices: [{ message: { content: "served" } }] });
const combo = (requestDeadline, handleSingleModel, extra = {}) => handleComboChat({
  body, models, handleSingleModel, log: silentLog, comboStrategy: "fallback", requestDeadline, ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network access in unit test"); }));
});

afterEach(() => {
  for (const requestDeadline of deadlines.splice(0)) {
    requestDeadline.abort();
    requestDeadline.dispose();
  }
  clearStickyComboSession("deadline-smart", "session");
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Combo request deadline", () => {
  it.each(["UPSTREAM_HEADERS_TIMEOUT", "CHAT_BUILD_TIMEOUT", "CLIENT_DISCONNECTED"])(
    "%s is terminal, not an unexpected exception eligible for the next member",
    async (code) => {
      const { requestDeadline } = deadline();
      const terminal = createRequestAbortError(code);
      const handleSingleModel = vi.fn().mockRejectedValueOnce(terminal).mockResolvedValue(successResponse());
      await expect(combo(requestDeadline, handleSingleModel)).rejects.toBe(terminal);
      expect(handleSingleModel).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["client", "budget"])("%s cancellation interrupts a 503 overloaded cooldown without the next model", async (stop) => {
    const { client, requestDeadline } = deadline(stop === "budget" ? 250 : 110_000);
    const started = deferred();
    const sleep = requestDeadline.sleep.bind(requestDeadline);
    vi.spyOn(requestDeadline, "sleep").mockImplementation((ms) => { started.resolve(ms); return sleep(ms); });
    const handleSingleModel = vi.fn().mockResolvedValueOnce(errorResponse(503, "overloaded")).mockResolvedValue(successResponse());
    const interrupted = expect(combo(requestDeadline, handleSingleModel)).rejects.toMatchObject({
      code: stop === "client" ? "CLIENT_DISCONNECTED" : "CHAT_BUILD_TIMEOUT",
    });
    expect(await started.promise).toBe(BACKOFF_CONFIG.base);
    if (stop === "client") client.abort();
    else await vi.advanceTimersByTimeAsync(250);
    await interrupted;
    await vi.advanceTimersByTimeAsync(BACKOFF_CONFIG.base);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["client", "budget"])("%s cancellation of a stalled early-SSE peek cancels its reader and does not fail open", async (stop) => {
    const { client, requestDeadline } = deadline(stop === "budget" ? 100 : 110_000);
    const acquired = deferred();
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(ROLE)); },
      cancel,
    });
    const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, "getReader").mockImplementation(() => { acquired.resolve(); return getReader(); });
    const handleSingleModel = vi.fn().mockResolvedValueOnce(new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    })).mockResolvedValue(successResponse());
    const interrupted = expect(combo(requestDeadline, handleSingleModel)).rejects.toMatchObject({
      code: stop === "client" ? "CLIENT_DISCONNECTED" : "CHAT_BUILD_TIMEOUT",
    });
    await acquired.promise;
    if (stop === "client") client.abort();
    else await vi.advanceTimersByTimeAsync(100);
    await interrupted;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the local 45-second peek fail-open and replays its pending read while build budget remains", async () => {
    const { requestDeadline } = deadline();
    let upstream;
    const stream = new ReadableStream({ start(controller) { upstream = controller; controller.enqueue(encoder.encode(ROLE)); } });
    const handleSingleModel = vi.fn().mockResolvedValue(new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }));
    const pending = combo(requestDeadline, handleSingleModel);
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;
    expect(requestDeadline.signal.aborted).toBe(false);
    expect(requestDeadline.remainingMs()).toBe(65_000);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(ROLE);
    upstream.enqueue(encoder.encode(CONTENT));
    upstream.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(CONTENT);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it("uses only the remaining shared budget after earlier work and a request-scoped member failure", async () => {
    const { requestDeadline } = deadline();
    await vi.advanceTimersByTimeAsync(50_000);
    const second = deferred();
    const remaining = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      remaining.push(requestDeadline.remainingMs());
      if (model === models[0]) {
        await requestDeadline.sleep(40_000);
        return errorResponse(400, "Request validation failed");
      }
      second.resolve();
      return new Promise(() => {});
    });
    const interrupted = expect(combo(requestDeadline, handleSingleModel)).rejects.toMatchObject({ code: "CHAT_BUILD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(40_000);
    await second.promise;
    expect(remaining).toEqual([60_000, 20_000]);
    await vi.advanceTimersByTimeAsync(20_000);
    await interrupted;
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual(models.slice(0, 2));
  });

  it.each([false, true])("does not swallow a smart-router header timeout (sticky=%s)", async (sticky) => {
    const { requestDeadline } = deadline();
    if (sticky) setStickyComboModel("deadline-smart", "session", models[0]);
    const terminal = createRequestAbortError("UPSTREAM_HEADERS_TIMEOUT");
    const handleSingleModel = vi.fn().mockResolvedValue(successResponse());
    await expect(combo(requestDeadline, handleSingleModel, {
      comboStrategy: "smart", comboName: "deadline-smart", sessionId: "session",
      resolveSmartChoice: vi.fn().mockRejectedValue(terminal),
    })).rejects.toBe(terminal);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  it.each([
    [400, "Request validation failed", 0],
    [503, "overloaded", BACKOFF_CONFIG.base],
    [504, "overloaded", BACKOFF_CONFIG.base],
  ])("preserves ordinary HTTP %s fallback rather than treating status alone as terminal", async (status, message, cooldown) => {
    const { requestDeadline } = deadline();
    const handleSingleModel = vi.fn().mockResolvedValueOnce(errorResponse(status, message)).mockResolvedValue(successResponse());
    const pending = combo(requestDeadline, handleSingleModel);
    await vi.advanceTimersByTimeAsync(cooldown);
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("served");
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual(models.slice(0, 2));
    expect(requestDeadline.signal.aborted).toBe(false);
  });

  it("cancels a Fusion panel without dispatching the judge and cleans late panel responses", async () => {
    const { client, requestDeadline } = deadline();
    const replies = [deferred(), deferred()];
    const handleSingleModel = vi.fn((_body, model) => replies[models.indexOf(model)].promise);
    const interrupted = expect(handleFusionChat({
      body, models: models.slice(0, 2), handleSingleModel, log: silentLog,
      comboName: "deadline-fusion", judgeModel: models[2], requestDeadline,
    })).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    client.abort();
    await interrupted;
    const cancels = [vi.fn(), vi.fn()];
    replies.forEach((reply, index) => reply.resolve(new Response(new ReadableStream({ cancel: cancels[index] }))));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["quorum grace", 8000, { stragglerGraceMs: 8000, panelHardTimeoutMs: 90_000 }],
    ["panel hard timeout", 90_000, { stragglerGraceMs: 100_000, panelHardTimeoutMs: 90_000 }],
  ])("abandons only the hanging Fusion child at %s, leaving the judge stream healthy", async (_label, elapsed, tuning) => {
    const { requestDeadline } = deadline();
    const hanging = deferred();
    const children = [];
    const judgeCancel = vi.fn();
    const judge = "provider-judge/judge";
    let judgeStream;
    const handleSingleModel = vi.fn((_body, model, isPanel, childDeadline) => {
      if (isPanel) {
        children.push(childDeadline);
        return model === models[2] ? hanging.promise : Promise.resolve(successResponse());
      }
      expect(model).toBe(judge);
      // The app callback uses its parent context when no panel override is supplied.
      expect(childDeadline).toBeUndefined();
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) { judgeStream = controller; controller.enqueue(encoder.encode(CONTENT)); },
        cancel: judgeCancel,
      }), { headers: { "content-type": "text/event-stream" } }));
    });
    const pending = handleFusionChat({
      body, models, handleSingleModel, log: silentLog, comboName: "deadline-fusion-quorum",
      judgeModel: judge, requestDeadline, tuning,
    });
    expect(children).toHaveLength(3);
    expect(children.every((child) => child !== requestDeadline && child.remainingMs() === requestDeadline.remainingMs())).toBe(true);
    await vi.advanceTimersByTimeAsync(elapsed);
    const response = await pending;
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([...models, judge]);
    expect(children[2].signal.aborted).toBe(true);
    expect(requestDeadline.signal.aborted).toBe(false);
    expect(getEventListeners(requestDeadline.signal, "abort")).toHaveLength(0);
    for (const child of children) expect(getEventListeners(child.signal, "abort")).toHaveLength(0);

    // A provider ignoring its child signal is still cleaned up if it eventually returns.
    const lateCancel = vi.fn();
    hanging.resolve(new Response(new ReadableStream({ cancel: lateCancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(lateCancel).toHaveBeenCalledTimes(1);

    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(CONTENT);
    requestDeadline.finish();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(110_001);
    expect(requestDeadline.signal.aborted).toBe(false);
    expect(judgeCancel).not.toHaveBeenCalled();
    judgeStream.enqueue(encoder.encode("still streaming"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("still streaming");
    await reader.cancel();
    expect(judgeCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });
});
