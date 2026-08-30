import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function jsonResponse() {
  return {
    response: new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

describe("handleChatCore per-model overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(jsonResponse());
  });

  it("forces chat transport + max thinking for opencode-go/deepseek-v4-flash", async () => {
    const credentials = { apiKey: "test-key", providerSpecificData: {} };
    const body = {
      model: "ocg/deepseek-v4-flash",
      stream: false,
      max_tokens: 64,
      system: "Be brief.",
      messages: [{ role: "user", content: "hi" }],
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "opencode-go", model: "deepseek-v4-flash" },
      credentials,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
      connectionId: "test-conn",
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      modelOverrides: {
        "opencode-go/deepseek-v4-flash": { protocol: "chat", thinking: "max" },
      },
      clientRawRequest: {
        endpoint: "/v1/messages",
        body,
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const call = executeMock.mock.calls[0][0];
    expect(credentials.runtimeTransport.baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(call.body.reasoning_effort).toBe("max");
    expect(call.body.thinking).toEqual({ type: "enabled" });
    expect(call.body.messages?.length || call.body.input?.length).toBeGreaterThan(0);
  });
});
