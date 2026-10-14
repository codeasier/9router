import { beforeEach, describe, expect, it, vi } from "vitest";

// Intercept the final network boundary, after BaseExecutor serializes the body.
// No provider, proxy, or model endpoint is contacted by these tests.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { normalizeResponsesMessageTypes } from "../../open-sse/translator/formats/responsesApi.js";

const PROVIDER = "openai-compatible-responses-test";
const MODEL = "deepseek-v4.1-flash";
const BASE = "https://upstream.example/v1";
const history = () => [
  { role: "developer", content: "You are helpful." },
  { role: "user", content: [{ type: "input_text", text: "Say ok" }] },
  { role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] },
  { role: "user", content: [{ type: "input_text", text: "Say ok again" }] },
];
const credentials = (apiType, runtimeTransport) => ({
  apiKey: "test-key",
  providerSpecificData: { baseUrl: BASE, ...(apiType ? { apiType } : {}) },
  ...(runtimeTransport ? { runtimeTransport } : {}),
});

async function send(body, { provider = PROVIDER, creds = credentials(), stream = false } = {}) {
  const result = await new DefaultExecutor(provider).execute({ model: MODEL, body, stream, credentials: creds });
  const [url, options] = fetchMock.mock.calls.at(-1);
  return { url, options, wire: JSON.parse(options.body), result };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}", {
    status: 200, headers: { "content-type": "application/json" },
  }));
});

describe("Responses message discriminators at the outbound fetch boundary (#27)", () => {
  const cases = [
    ["A: single turn", () => history().slice(0, 2)],
    ["B: output_text assistant history", history],
    ["C: already typed history", () => history().map(item => ({ ...item, type: "message" }))],
    ["D: string assistant history", () => history().map(item => item.role === "assistant" ? { ...item, content: "ok" } : item)],
  ];
  for (const stream of [false, true]) {
    for (const [name, makeInput] of cases) {
      it(`${name}, stream=${stream}, survives same-format translation`, async () => {
        const body = { model: MODEL, input: makeInput(), max_output_tokens: 512, stream };
        const original = structuredClone(body);
        const creds = credentials();
        const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, MODEL, body, stream, creds, PROVIDER);
        const { url, wire, options } = await send(translated, { creds, stream });
        expect(url).toBe(`${BASE}/responses`);
        expect(wire.input).toEqual(original.input.map(item => ({ ...item, type: "message" })));
        expect(wire.stream).toBe(stream);
        expect(options.headers.Accept).toBe(stream ? "text/event-stream" : undefined);
        expect(body).toEqual(original);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    }

    it(`covers Chat to Responses translation, stream=${stream}`, async () => {
      const body = { model: MODEL, messages: [
        { role: "user", content: "Say ok" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "Say ok again" },
      ], stream };
      const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, MODEL, body, stream, credentials(), PROVIDER);
      const { wire } = await send(translated, { stream });
      expect(wire.input).toHaveLength(3);
      expect(wire.input.every(item => item.type === "message")).toBe(true);
      expect(wire.input.map(item => item.role)).toEqual(["user", "assistant", "user"]);
      expect(JSON.stringify(wire.input)).toContain("Say ok again");
    });
  }

  it.each([
    ["openai-compatible-chat-test", "responses", undefined, true],
    [PROVIDER, "chat", undefined, false],
    [PROVIDER, "responses", FORMATS.OPENAI, false],
    ["openai-compatible-chat-test", "chat", FORMATS.OPENAI_RESPONSES, true],
    ["volceapi", undefined, FORMATS.OPENAI_RESPONSES, true],
    ["openai", undefined, undefined, false],
  ])("respects target selection: %s / apiType=%s / runtime=%s", async (provider, apiType, format, normalize) => {
    const rt = format ? { format, baseUrl: `${BASE}/${format === FORMATS.OPENAI_RESPONSES ? "responses" : "chat/completions"}` } : undefined;
    const { wire } = await send({ input: history() }, { provider, creds: credentials(apiType, rt) });
    expect(wire.input).toEqual(normalize ? history().map(item => ({ ...item, type: "message" })) : history());
  });

  it("preserves typed tools, reasoning, references, output_text and multimodal content", async () => {
    const input = [
      ...history(),
      { role: "system", content: "policy" },
      { role: "user", content: [{ type: "input_image", image_url: "https://images.example/a.png" }, { type: "input_file", file_id: "file_test" }] },
      { type: "function_call", call_id: "call_test", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_test", output: "ok" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "reason" }], encrypted_content: "opaque" },
      { type: "item_reference", id: "msg_test" },
      { type: "custom_tool_call", call_id: "call_custom", input: "hello" },
      { type: "custom_tool_call_output", call_id: "call_custom", output: "world" },
      { type: "future_item", role: "assistant", content: "preserve explicit discriminator" },
    ];
    const original = structuredClone(input);
    const body = { input };
    const { wire, result } = await send(body);
    expect(wire.input.slice(6)).toEqual(original.slice(6));
    expect(wire.input.slice(0, 6)).toEqual(original.slice(0, 6).map(item => ({ ...item, type: "message" })));
    expect(input).toEqual(original);
    expect(result.transformedBody).not.toBe(body);
    expect(result.transformedBody.input).not.toBe(input);
    expect(result.transformedBody.input[2]).not.toBe(input[2]);
    expect(result.transformedBody.input[2].content).toBe(input[2].content);
    const again = await send(result.transformedBody);
    expect(again.wire).toEqual(wire);
  });

  it.each(["plain input", "", null, undefined, 123, { role: "user", content: "invalid envelope" }])("leaves non-array input unchanged: %j", async input => {
    const { wire } = await send({ input });
    expect(wire.input).toEqual(input);
  });

  it("does not guess types for malformed messages or other item shapes", async () => {
    const input = [null, "text", 4, [], {}, { role: "tool", content: "output" },
      { role: "assistant" }, { role: "user", content: null }, { role: "user", content: {} },
      { role: "unknown", content: "text" }, { type: null, role: "user", content: "text" },
      { type: "", role: "user", content: "text" }];
    const { wire } = await send({ input });
    expect(wire.input).toEqual(input);
  });

  it("normalizes empty message content without changing empty input", async () => {
    expect((await send({ input: [] })).wire.input).toEqual([]);
    expect((await send({ input: [{ role: "user", content: "" }, { role: "assistant", content: [] }] })).wire.input)
      .toEqual([{ type: "message", role: "user", content: "" }, { type: "message", role: "assistant", content: [] }]);
  });

  it("can normalize frozen shared histories and is idempotent", () => {
    const input = Object.freeze(history().map(item => Object.freeze(item)));
    const output = normalizeResponsesMessageTypes(input);
    expect(output).not.toBe(input);
    expect(output[0]).not.toBe(input[0]);
    expect(normalizeResponsesMessageTypes(output)).toEqual(output);
    expect(input.every(item => item.type === undefined)).toBe(true);
  });
});
