// Request preparation has one absolute budget, including account/model fallback.
// Keep the app, Combo and key-policy lifecycle real; never touch persistence or a provider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {},
  getSettings: vi.fn(),
  getComboModels: vi.fn(),
  getModelInfo: vi.fn(),
  credentials: vi.fn(),
  refresh: vi.fn(),
  markUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  core: vi.fn(),
  pxpipe: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getApiKeyByKey: async () => ({ policy: { maxConcurrent: 1 } }),
  getCustomModels: async () => [],
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.replace("Bearer ", ""),
  isValidApiKey: async () => true,
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: mocks.markUnavailable,
  clearAccountError: mocks.clearAccountError,
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => ({}),
  enforceKeyAccess: async () => null,
  enforceKeyAccessResolved: async () => null,
  filterAdapterModels: async (_access, models) => models,
}));
vi.mock("@/sse/services/modelAllowlist.js", () => ({ getAllowedComboModelIds: async () => null }));
vi.mock("@/dashboardGuard", () => ({ isManagementAuthenticated: async () => false }));
vi.mock("@/shared/constants/models", () => ({ PROVIDER_MODELS: {} }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.refresh, updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/systemoneRouter.js", () => ({ resolveSmartChoice: vi.fn() }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (handler) => handler,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: mocks.pxpipe }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: () => "test-key",
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const policy = await import("@/sse/services/keyPolicy.js");
const { createRequestAbortError } = await import("open-sse/utils/requestDeadline.js");
const { CHAT_BUILD_TIMEOUT_MS } = await import("open-sse/config/runtimeConfig.js");
const compactPOST = (await import("@/app/api/v1/responses/compact/route.js")).POST;
const geminiPOST = (await import("@/app/api/v1beta/models/[...path]/route.js")).POST;
const KEY = "sk-build-deadline-fixture";
const controllers = [];

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function request(model = "provider-a/model-a") {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
      signal: controller.signal,
    }),
  };
}

function credentials(id = "account-a") {
  return { connectionId: id, connectionName: id, accessToken: "unit-test-placeholder" };
}

function coreError(status, message = "Request validation failed") {
  const body = { error: { message } };
  const response = new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  // Only the read-only Combo inspection is mocked, not the final error response.
  vi.spyOn(response, "clone").mockReturnValue({ json: async () => body });
  return { success: false, status, error: message, response };
}

const inflight = async () => (await policy.getKeyPolicyStatus(KEY)).inflight;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network access in unit test"); }));
  policy._resetKeyPolicyState();
  policy._setBudgetQuery(async () => 0);
  mocks.settings = { requireApiKey: true, comboStrategy: "fallback" };
  mocks.getSettings.mockImplementation(async () => mocks.settings);
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockImplementation(async (name) => {
    const slash = name.indexOf("/");
    return slash < 0 ? { provider: null } : { provider: name.slice(0, slash), model: name.slice(slash + 1) };
  });
  mocks.credentials.mockImplementation(async () => credentials());
  mocks.refresh.mockImplementation(async (_provider, value) => value);
  mocks.markUnavailable.mockImplementation(async (_id, status) => ({ shouldFallback: status >= 500 }));
  mocks.core.mockImplementation(async () => ({ success: true, response: new Response(null, { status: 204 }) }));
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  policy._resetKeyPolicyState();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("app chat build deadline", () => {
  it("shares 110 seconds across two accounts and the next Combo model, rather than restarting", async () => {
    expect(CHAT_BUILD_TIMEOUT_MS).toBe(110_000);
    mocks.getComboModels.mockImplementation(async (model) => model === "combo"
      ? ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"] : null);
    mocks.credentials.mockImplementation(async (provider, excluded) => credentials(
      provider === "provider-a" ? (excluded.size ? "account-a2" : "account-a1") : "account-b",
    ));
    const entered = [deferred(), deferred(), deferred()];
    const replies = [deferred(), deferred(), deferred()];
    const attempts = [];
    mocks.core.mockImplementation((args) => {
      const index = attempts.length;
      attempts.push({ ...args, remaining: args.requestDeadline.remainingMs() });
      entered[index].resolve();
      return replies[index].promise;
    });
    let finished = false;
    const result = handleChat(request("combo").request).then((response) => { finished = true; return response; });
    await entered[0].promise;
    await vi.advanceTimersByTimeAsync(40_000);
    replies[0].resolve(coreError(503, "service unavailable"));
    await entered[1].promise;
    await vi.advanceTimersByTimeAsync(40_000);
    replies[1].resolve(coreError(400));
    await entered[2].promise;

    expect(attempts.map((attempt) => attempt.remaining)).toEqual([110_000, 70_000, 30_000]);
    expect(new Set(attempts.map((attempt) => attempt.requestDeadline)).size).toBe(1);
    expect(attempts.map((attempt) => attempt.connectionId)).toEqual(["account-a1", "account-a2", "account-b"]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).status).toBe(504);
    expect(attempts[2].signal.reason).toMatchObject({ code: "CHAT_BUILD_TIMEOUT" });
    expect(mocks.core).toHaveBeenCalledTimes(3);
    // Only the real 503/400 were classified; the local timeout never poisons account-b.
    expect(mocks.markUnavailable).toHaveBeenCalledTimes(2);
    expect(await inflight()).toBe(0);

    const cancel = vi.fn();
    replies[2].resolve({ success: true, response: new Response(new ReadableStream({ cancel })) });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.core).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["CLIENT_DISCONNECTED", 499],
    ["CHAT_BUILD_TIMEOUT", 504],
    ["UPSTREAM_HEADERS_TIMEOUT", 504],
  ])("treats %s as terminal through nested Combos, without penalizing an account", async (code, status) => {
    mocks.getComboModels.mockImplementation(async (model) => ({
      outer: ["inner", "provider-c/model-c"],
      inner: ["provider-a/model-a", "provider-b/model-b"],
    })[model] || null);
    mocks.core.mockImplementation(async () => ({
      ...coreError(status, "local request stopped"), terminalRequestError: createRequestAbortError(code),
    }));
    const response = await handleChat(request("outer").request);
    expect(response.status).toBe(status);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(await inflight()).toBe(0);
  });

  it.each(["body", "credentials", "refresh", "pxpipe"])(
    "client cancellation during %s stops the build even if preprocessing resolves late",
    async (stage) => {
      const entered = deferred();
      const late = deferred();
      const current = request();
      const operation = () => { entered.resolve(); return late.promise; };
      let value = credentials();
      if (stage === "body") {
        vi.spyOn(current.request, "json").mockImplementation(operation);
        value = { model: "provider-a/model-a", messages: [] };
      } else if (stage === "credentials") mocks.credentials.mockImplementationOnce(operation);
      else if (stage === "refresh") mocks.refresh.mockImplementationOnce(operation);
      else {
        mocks.settings.pxpipeEnabled = true;
        mocks.pxpipe.mockImplementationOnce(operation);
        value = () => {};
      }
      const pending = handleChat(current.request);
      await entered.promise;
      current.controller.abort(new Error("caller-specific private reason"));
      const response = await pending;
      expect(response.status).toBe(499);
      expect(await response.text()).not.toContain("caller-specific private reason");
      expect(await inflight()).toBe(0);
      late.resolve(value);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.core).not.toHaveBeenCalled();
      expect(mocks.markUnavailable).not.toHaveBeenCalled();
    },
  );

  it("bounds request.json itself rather than starting the budget after parsing", async () => {
    const current = request();
    vi.spyOn(current.request, "json").mockReturnValue(new Promise(() => {}));
    const pending = handleChat(current.request);
    await vi.advanceTimersByTimeAsync(CHAT_BUILD_TIMEOUT_MS);
    expect((await pending).status).toBe(504);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
    expect(await inflight()).toBe(0);
  });

  it("does not select another account after cancellation during fallback classification", async () => {
    const entered = deferred();
    const late = deferred();
    mocks.core.mockResolvedValue(coreError(503, "service unavailable"));
    mocks.markUnavailable.mockImplementationOnce(() => { entered.resolve(); return late.promise; });
    const current = request();
    const pending = handleChat(current.request);
    await entered.promise;
    current.controller.abort();
    expect((await pending).status).toBe(499);
    late.resolve({ shouldFallback: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(await inflight()).toBe(0);
  });

  it.each([
    ["compact", (value) => compactPOST(value)],
    ["Gemini", (value) => geminiPOST(value, { params: Promise.resolve({ path: ["provider-a", "model-a:streamGenerateContent"] }) })],
  ])("preserves client cancellation when the %s route rebuilds the Request", async (_name, POST) => {
    const entered = deferred();
    mocks.credentials.mockImplementationOnce(() => { entered.resolve(); return new Promise(() => {}); });
    const current = request();
    const pending = POST(current.request);
    await entered.promise;
    current.controller.abort();
    expect((await pending).status).toBe(499);
    expect(mocks.core).not.toHaveBeenCalled();
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
    expect(await inflight()).toBe(0);
  });

  it("does not cut a handed-off stream at 110 seconds, but later client abort cancels it and releases its key lease", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    let upstream;
    let build;
    mocks.core.mockImplementation(async ({ requestDeadline }) => {
      build = requestDeadline;
      return {
        success: true,
        response: new Response(new ReadableStream({
          start(controller) { upstream = controller; controller.enqueue(encoder.encode("first")); },
          cancel,
        }), { headers: { "content-type": "text/event-stream" } }),
      };
    });
    const current = request();
    const response = await handleChat(current.request);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    expect(await inflight()).toBe(1);
    await vi.advanceTimersByTimeAsync(CHAT_BUILD_TIMEOUT_MS + 20_000);
    expect(build.signal.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(await inflight()).toBe(1);
    upstream.enqueue(encoder.encode("still streaming"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("still streaming");

    const interrupted = expect(reader.read()).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
    current.controller.abort();
    await interrupted;
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await inflight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });
});
