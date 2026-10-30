import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const model = "gpt-6.1-sol-parallel";
const tool = { type: "function", name: "get_time", parameters: { type: "object", properties: { city: { type: "string" } } } };
const calls = ["Tokyo", "London"].map((city, index) => ({
  type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: tool.name,
  arguments: JSON.stringify({ city }), status: "completed",
}));

// This fixture checks forwarding of multiple upstream calls, not model behavior.
function upstreamResponse() {
  const response = { id: "resp_fixture", object: "response", model: "gpt-6.1-sol", status: "completed", output: calls };
  const events = calls.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", output_index, item },
  ]);
  events.push({ type: "response.completed", response });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => vi.restoreAllMocks());

async function request(body, { chat = false, native = false } = {}) {
  return handleChatCore({
    body: { model: `cx/${model}`, reasoning: { effort: "high" }, parallel_tool_calls: true, ...body },
    modelInfo: { provider: "codex", model },
    credentials: { connectionId: "parallel-fixture", accessToken: "fixture-token", providerSpecificData: {} },
    connectionId: "parallel-fixture",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    sourceFormatOverride: chat ? "openai" : "openai-responses",
    clientRawRequest: {
      endpoint: chat ? "/v1/chat/completions" : "/v1/responses",
      headers: { "user-agent": native ? "codex-cli/0.159.0" : "opencode/1.19.0" },
    },
  });
}

describe("Sol parallel transport through translation and execution (#36)", () => {
  it.each([
    { chat: false, native: false, stream: false },
    { chat: false, native: false, stream: true },
    { chat: false, native: true, stream: false },
    { chat: true, native: false, stream: false },
  ])("forwards two upstream tool calls: $chat/$native/$stream", async ({ chat, native, stream }) => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async () => upstreamResponse());
    const result = await request({
      stream,
      ...(chat ? { messages: [{ role: "user", content: "Get both times" }], tools: [{ type: "function", function: tool }] }
        : { input: "Get both times", tools: [structuredClone(tool)] }),
    }, { chat, native });
    expect(result.success).toBe(true);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(options.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(body).toMatchObject({ model: "gpt-6.1-sol", parallel_tool_calls: true });
    expect(body.tools[0]).toMatchObject(tool);
    expect(body.input.some(item => item.type === "additional_tools")).toBe(false);
    if (stream) {
      const text = await result.response.text();
      const added = text.split("\n").filter(line => line.startsWith("data: ") && line.slice(6) !== "[DONE]").map(line => JSON.parse(line.slice(6)))
        .filter(event => event.type === "response.output_item.added" && event.item?.type === "function_call");
      expect(added.map(event => event.item.call_id)).toEqual(["call_0", "call_1"]);
    } else {
      const response = await result.response.json();
      const actual = chat ? response.choices[0].message.tool_calls.map(call => call.id)
        : response.output.filter(item => item.type === "function_call").map(call => call.call_id);
      expect(actual).toEqual(["call_0", "call_1"]);
    }
  });

  it("replays both calls and results through the next Responses turn", async () => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async () => upstreamResponse());
    const first = await request({ input: "Get both times", tools: [structuredClone(tool)], stream: false });
    const response = await first.response.json();
    const input = [
      { role: "user", content: "Get both times" }, ...response.output,
      ...response.output.filter(item => item.type === "function_call").map(call => ({
        type: "function_call_output", call_id: call.call_id, output: "12:00",
      })),
    ];
    const second = await request({ input, tools: [structuredClone(tool)], stream: false });
    await second.response.text();
    const [, options] = fetchMock.mock.calls[1];
    const body = JSON.parse(options.body);
    expect(options.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.input.filter(item => item.type === "function_call").map(item => item.call_id)).toEqual(["call_0", "call_1"]);
    expect(body.input.filter(item => item.type === "function_call_output").map(item => item.call_id)).toEqual(["call_0", "call_1"]);
  });
});
