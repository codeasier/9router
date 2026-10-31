import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), refresh: vi.fn(), logger: vi.fn(), prefetch: vi.fn(),
  pending: vi.fn(), appendLog: vi.fn(async () => {}), saveDetail: vi.fn(async () => {}),
  lookup: vi.fn(), usage: vi.fn(async () => {}), noAuth: true,
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: mocks.noAuth, execute: mocks.execute, refreshCredentials: mocks.refresh }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: mocks.logger }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ buildCredentialProxyOptions: () => ({}) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: mocks.prefetch }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: mocks.pending, appendRequestLog: mocks.appendLog,
  saveRequestDetail: mocks.saveDetail, saveRequestUsage: mocks.usage,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { createRequestDeadline, createRequestAbortError } = await import("../../open-sse/utils/requestDeadline.js");
const { CHAT_BUILD_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");
const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
const { prefetchRemoteImages } = await vi.importActual("../../open-sse/translator/concerns/prefetch.js");

const encoder = new TextEncoder();
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function upstream(response = new Response(JSON.stringify({
  id: "test", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
}), { headers: { "content-type": "application/json" } })) {
  return { response, url: "https://provider.invalid/chat", headers: {}, transformedBody: null };
}
function options(extra = {}) {
  const body = { model: "openai/gpt-test", stream: false, messages: [{ role: "user", content: "hello" }] };
  return {
    body, modelInfo: { provider: "openai", model: "gpt-test" },
    credentials: { apiKey: "fixture-only", providerSpecificData: {} },
    connectionId: "deadline-test",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    ...extra,
  };
}
async function reached(mock, count = 1) {
  for (let n = 0; n < 150 && mock.mock.calls.length < count; n++) await Promise.resolve();
  expect(mock).toHaveBeenCalledTimes(count);
}
async function flush() {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}
function stalledBody(contentType = "application/json", status = 200) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { status, headers: { "content-type": contentType } });
  return { response, cancel };
}
function expectReleasedOnce() {
  expect(mocks.pending.mock.calls.filter((args) => args[3] === true)).toHaveLength(1);
  expect(mocks.pending.mock.calls.filter((args) => args[3] === false)).toHaveLength(1);
  expect(mocks.pending.mock.calls.some((args) => args[4] === true)).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.noAuth = true;
  mocks.execute.mockReset().mockImplementation(async () => upstream());
  mocks.refresh.mockReset().mockResolvedValue(null);
  mocks.prefetch.mockReset().mockResolvedValue(0);
  mocks.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.logger.mockReset().mockResolvedValue({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
    appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn(), appendOpenAIChunk: vi.fn(),
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request in deadline test"); }));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat core response-preparation deadline", () => {
  it("rejects a pre-aborted request without starting preprocessing or penalizing a concurrent account", async () => {
    const client = new AbortController();
    client.abort(new Error("private user reason"));
    const result = await handleChatCore(options({ signal: client.signal }));
    expect(result.status).toBe(499);
    expect(result.terminalRequestError.code).toBe("CLIENT_DISCONNECTED");
    expect(await result.response.text()).not.toContain("private user reason");
    expect(mocks.logger).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
  });

  it("bounds asynchronous request logger creation and stops late preprocessing", async () => {
    const client = new AbortController();
    const logger = deferred();
    mocks.logger.mockReturnValue(logger.promise);
    const pending = handleChatCore(options({ signal: client.signal }));
    await reached(mocks.logger);
    client.abort("private reason");
    const result = await pending;
    expect(result.status).toBe(499);
    logger.resolve({ logRawRequest: vi.fn() });
    await flush();
    expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("includes image preprocessing in the original budget and never dispatches after a late completion", async () => {
    const image = deferred();
    mocks.prefetch.mockReturnValue(image.promise);
    const deadline = createRequestDeadline({ timeoutMs: 40 });
    const pending = handleChatCore(options({ requestDeadline: deadline }));
    await reached(mocks.prefetch);
    expect(mocks.prefetch.mock.calls[0][3].signal).toBe(deadline.signal);
    await vi.advanceTimersByTimeAsync(40);
    const result = await pending;
    expect(result.status).toBe(504);
    expect(result.terminalRequestError.code).toBe("CHAT_BUILD_TIMEOUT");
    image.resolve(1);
    await flush();
    expect(mocks.execute).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("cancels Headroom instead of swallowing the request abort as fail-open", async () => {
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const deadline = createRequestDeadline({ timeoutMs: 35 });
    const pending = handleChatCore(options({ requestDeadline: deadline, headroomEnabled: true, headroomUrl: "https://compress.invalid" }));
    await reached(fetch);
    await vi.advanceTimersByTimeAsync(35);
    expect((await pending).terminalRequestError.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.execute).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("cancels local PXPIPE work without dispatching or publishing late saver events", async () => {
    const transform = vi.fn(() => new Promise(() => {}));
    const onPxpipeEvent = vi.fn();
    const deadline = createRequestDeadline({ timeoutMs: 35 });
    const pending = handleChatCore(options({
      requestDeadline: deadline, modelInfo: { provider: "anthropic", model: "claude-test" },
      pxpipeEnabled: true, pxpipeMinChars: 1, pxpipeTransform: transform, onPxpipeEvent,
    }));
    await reached(transform);
    await vi.advanceTimersByTimeAsync(35);
    expect((await pending).status).toBe(504);
    expect(onPxpipeEvent).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("aborts a non-cooperating executor, discards its late response and releases pending exactly once", async () => {
    const execute = deferred();
    mocks.execute.mockReturnValue(execute.promise);
    const deadline = createRequestDeadline({ timeoutMs: 50 });
    const pending = handleChatCore(options({ requestDeadline: deadline }));
    await reached(mocks.execute);
    expect(mocks.execute.mock.calls[0][0].requestDeadline).toBe(deadline);
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.terminalRequestError.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(mocks.execute.mock.calls[0][0].signal.aborted).toBe(true);
    const late = stalledBody();
    execute.resolve(upstream(late.response));
    await flush();
    expect(late.cancel).toHaveBeenCalledTimes(1);
    expectReleasedOnce();
    deadline.dispose();
  });

  it("creates a bounded lifecycle for standalone engine callers", async () => {
    mocks.execute.mockReturnValue(new Promise(() => {}));
    const pending = handleChatCore(options());
    await reached(mocks.execute);
    await vi.advanceTimersByTimeAsync(CHAT_BUILD_TIMEOUT_MS);
    expect((await pending).terminalRequestError.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(mocks.execute.mock.calls[0][0].signal.aborted).toBe(true);
    expectReleasedOnce();
  });

  it("normalizes a bare executor AbortError to a safe terminal client cancellation", async () => {
    mocks.execute.mockRejectedValue(new DOMException("private abort reason", "AbortError"));
    const result = await handleChatCore(options());
    expect(result.status).toBe(499);
    expect(result.terminalRequestError.code).toBe("CLIENT_DISCONNECTED");
    expect(await result.response.text()).not.toContain("private abort reason");
    expectReleasedOnce();
  });

  it("preserves a headers-timeout terminal marker instead of treating it as account failure", async () => {
    mocks.execute.mockRejectedValue(createRequestAbortError("UPSTREAM_HEADERS_TIMEOUT"));
    const result = await handleChatCore(options());
    expect(result.status).toBe(504);
    expect(result.terminalRequestError.code).toBe("UPSTREAM_HEADERS_TIMEOUT");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expectReleasedOnce();
  });

  it("persists an already-started rotating refresh after cancellation without retrying inference", async () => {
    mocks.noAuth = false;
    mocks.execute.mockResolvedValue(upstream(new Response("unauthorized", { status: 401 })));
    const refresh = deferred();
    mocks.refresh.mockReturnValue(refresh.promise);
    const client = new AbortController();
    const onCredentialsRefreshed = vi.fn();
    const credentials = { accessToken: "old-fixture", refreshToken: "old-refresh-fixture", providerSpecificData: {} };
    const pending = handleChatCore(options({ signal: client.signal, credentials, onCredentialsRefreshed }));
    await reached(mocks.refresh);
    client.abort("private reason");
    expect((await pending).status).toBe(499);
    refresh.resolve({ accessToken: "late-fixture", refreshToken: "late-refresh-fixture" });
    await flush();
    expect(credentials.accessToken).toBe("late-fixture");
    expect(credentials.refreshToken).toBe("late-refresh-fixture");
    expect(onCredentialsRefreshed).toHaveBeenCalledExactlyOnceWith({ accessToken: "late-fixture", refreshToken: "late-refresh-fixture" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expectReleasedOnce();
  });

  it("interrupts refresh backoff without starting the next refresh attempt", async () => {
    mocks.noAuth = false;
    mocks.execute.mockResolvedValue(upstream(new Response("unauthorized", { status: 401 })));
    const deadline = createRequestDeadline({ timeoutMs: 75 });
    const pending = handleChatCore(options({ requestDeadline: deadline }));
    await reached(mocks.refresh);
    await vi.advanceTimersByTimeAsync(75);
    expect((await pending).status).toBe(504);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expectReleasedOnce();
    deadline.dispose();
  });

  it.each([
    { title: "JSON aggregation", type: "application/json", status: 200, provider: "openai", stream: false },
    { title: "error-body parsing", type: "application/json", status: 503, provider: "openai", stream: false },
    { title: "forced Responses SSE aggregation", type: "text/event-stream", status: 200, provider: "codex", stream: false },
    { title: "HTML rejection before streaming handoff", type: "text/html", status: 200, provider: "openai", stream: true },
  ])("keeps the budget active through $title", async ({ type, status, provider, stream }) => {
    const stalled = stalledBody(type, status);
    mocks.execute.mockResolvedValue(upstream(stalled.response));
    const deadline = createRequestDeadline({ timeoutMs: 50 });
    const onRequestSuccess = vi.fn();
    const opts = options({ requestDeadline: deadline, onRequestSuccess, modelInfo: { provider, model: "gpt-test" } });
    opts.body.stream = stream;
    const pending = handleChatCore(opts);
    await reached(mocks.execute);
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.terminalRequestError.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expectReleasedOnce();
    deadline.dispose();
  });

  it("aggregates a JSON reply from a forced-stream provider for a non-streaming client", async () => {
    const result = await handleChatCore(options());
    expect(mocks.execute.mock.calls[0][0].stream).toBe(true);
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("application/json");
    expect((await result.response.json()).choices[0].message.content).toBe("ok");
    expectReleasedOnce();
  });

  it("shares the original account/combo deadline instead of finishing or resetting it", async () => {
    const deadline = createRequestDeadline({ timeoutMs: 100 });
    const finish = vi.spyOn(deadline, "finish");
    mocks.execute.mockResolvedValueOnce(upstream(new Response("temporary", { status: 503 })));
    const first = await handleChatCore(options({ requestDeadline: deadline }));
    expect(first.status).toBe(503);
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(70);
    mocks.execute.mockReturnValue(new Promise(() => {}));
    const second = handleChatCore(options({ requestDeadline: deadline }));
    await reached(mocks.execute, 2);
    await vi.advanceTimersByTimeAsync(30);
    expect((await second).terminalRequestError.code).toBe("CHAT_BUILD_TIMEOUT");
    expect(finish).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it.each([
    { title: "native Codex regular", provider: "codex", model: "gpt-6.1-sol-parallel", wire: "openai-responses", client: "codex-cli/fixture" },
    { title: "OpenCode Go chat", provider: "opencode-go", model: "deepseek-v4.1-flash", wire: "openai", client: "opencode/fixture" },
    { title: "OpenCode client to Codex regular", provider: "codex", model: "gpt-6.1-sol-parallel", wire: "openai-responses", client: "opencode/fixture" },
    { title: "OpenCode client to Codex Lite", provider: "codex", model: "gpt-6-luna", wire: "openai-responses", client: "opencode/fixture" },
  ])("keeps a healthy $title stream alive past the build budget, then cancels on disconnect", async ({ provider, model, wire, client: userAgent }) => {
    let source;
    const cancel = vi.fn();
    const providerResponse = new Response(new ReadableStream({ start(controller) { source = controller; }, cancel }), {
      headers: { "content-type": "text/event-stream" },
    });
    mocks.execute.mockResolvedValue(upstream(providerResponse));
    const client = new AbortController();
    const opts = options({ signal: client.signal, modelInfo: { provider, model }, userAgent, sourceFormatOverride: wire });
    opts.body = {
      model: `${provider}/${model}`, stream: true,
      ...(wire === "openai-responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }),
    };
    opts.clientRawRequest = {
      endpoint: wire === "openai-responses" ? "/v1/responses" : "/v1/chat/completions",
      body: opts.body, headers: { "user-agent": userAgent },
    };
    const result = await handleChatCore(opts);
    expect(result.success).toBe(true);
    const dispatch = mocks.execute.mock.calls[0][0];
    expect(dispatch.model).toBe(model);
    if (wire === "openai") {
      expect(opts.credentials.runtimeTransport.format).toBe("openai");
      expect(dispatch.body.messages).toBeDefined();
    } else expect(dispatch.body.input).toBeDefined();

    const read = result.response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    let settled = false;
    // SSE event/data/blank lines are separate output chunks. Continuously drain
    // them; never assume that one upstream frame corresponds to one reader.read.
    const consumption = (async () => {
      while (true) {
        const { done, value } = await read.read();
        if (done) return;
        received += decoder.decode(value, { stream: true });
      }
    })().then(
      () => { settled = true; return null; },
      (error) => { settled = true; return error; },
    );
    for (let elapsed = 0; elapsed <= CHAT_BUILD_TIMEOUT_MS + 20_000; elapsed += 20_000) {
      const marker = `chunk-at-${elapsed}`;
      const event = wire === "openai-responses"
        ? { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fixture", delta: marker }
        : { choices: [{ index: 0, delta: { content: marker } }] };
      const chunk = `${wire === "openai-responses" ? "event: response.output_text.delta\n" : ""}data: ${JSON.stringify(event)}\n\n`;
      source.enqueue(encoder.encode(chunk));
      for (let n = 0; n < 150 && !received.includes(marker); n++) await Promise.resolve();
      expect(received).toContain(marker);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(dispatch.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    client.abort("private disconnect reason");
    expect(await consumption).toMatchObject({ code: "CLIENT_DISCONNECTED" });
    // Fresh reads reject after abort even if earlier reads already delivered data.
    await expect(read.read()).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
    await flush();
    expect(dispatch.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expectReleasedOnce();
    read.releaseLock();
  });

  it("keeps actual terminal usage when its completion callback follows an immediate disconnect", () => {
    const deadline = createRequestDeadline({ timeoutMs: 50 });
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "openai", model: "gpt-test", connectionId: "deadline-test", body: {},
      stream: true, requestStartTime: Date.now(), requestDeadline: deadline,
    });
    deadline.abort(createRequestAbortError("CLIENT_DISCONNECTED"));
    onStreamComplete({ content: "generated before disconnect" }, { prompt_tokens: 25, completion_tokens: 5 }, Date.now());
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({
      tokens: expect.objectContaining({ prompt_tokens: 25, completion_tokens: 5 }),
    }));
    expect(mocks.saveDetail).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    deadline.dispose();
  });

  it("removes stream signal listeners on completion and never relays raw cancellation text", () => {
    const client = new AbortController();
    const remove = vi.spyOn(client.signal, "removeEventListener");
    const onDisconnect = vi.fn();
    const controller = createStreamController({ signal: client.signal, onDisconnect });
    controller.handleComplete();
    client.abort("private text");
    expect(controller.signal.aborted).toBe(false);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not dispatch image fetch after a DNS lookup resolves after cancellation", async () => {
    const client = new AbortController();
    const dns = deferred();
    mocks.lookup.mockReturnValue(dns.promise);
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://public.invalid/one.png" } },
    ] }] };
    const pending = prefetchRemoteImages(body, "openai", "gemini", { signal: client.signal });
    const aborted = expect(pending).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
    await reached(mocks.lookup);
    client.abort("private reason");
    await aborted;
    dns.resolve([{ address: "93.184.216.34", family: 4 }]);
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stops real image prefetch after cancellation without fetching the next image", async () => {
    const client = new AbortController();
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://public.invalid/one.png" } },
      { type: "image_url", image_url: { url: "https://public.invalid/two.png" } },
    ] }] };
    const pending = prefetchRemoteImages(body, "openai", "gemini", { signal: client.signal });
    const aborted = expect(pending).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
    await reached(fetch);
    client.abort("private reason");
    await aborted;
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
});
