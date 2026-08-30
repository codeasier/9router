import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, refreshMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
    refreshCredentials: refreshMock,
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
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
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

describe("handleChatCore strictProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(jsonResponse());
  });

  it("forwards pool strictProxy to the executor", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };
    await handleChatCore({
      body: {
        model: "ocg/deepseek-v4-flash",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "opencode-go", model: "deepseek-v4-flash" },
      credentials: {
        apiKey: "test-key",
        connectionName: "qyong2026@gmail.com",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://172.17.0.1:7895/",
          connectionNoProxy: "",
          connectionProxyPoolId: "a37a0712-8033-4683-892a-0ecbc8d478a1",
          strictProxy: true,
        },
      },
      log,
      connectionId: "codex-1",
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      modelOverrides: {
        "opencode-go/deepseek-v4-flash": { protocol: "chat" },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {
          model: "ocg/deepseek-v4-flash",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].proxyOptions).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://172.17.0.1:7895/",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      "PROXY",
      expect.stringMatching(/url=http:\/\/172\.17\.0\.1:7895\/? \| strict=true/),
    );
  });
});
