// Native Gemini passthrough: a Gemini client body must reach a Gemini-family
// upstream untouched (only the vendor envelope is added), and the answer must
// come back as GenerateContentResponse without an OpenAI pivot.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS, detectFormatByEndpoint } from "../../open-sse/translator/formats.js";
import { openAICompletionToGeminiResponse } from "../../open-sse/translator/response/openai-to-gemini.js";

const geminiBody = () => ({
  model: "ag/gemini-3.8-flash",
  stream: true,
  systemInstruction: { parts: [{ text: "be brief" }] },
  contents: [
    {
      role: "user",
      parts: [
        { text: "what is this?" },
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    },
  ],
  generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
});

describe("gemini → antigravity request", () => {
  const out = translateRequest(FORMATS.GEMINI, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-high", geminiBody(), true);

  it("wraps the payload in the v1internal envelope", () => {
    expect(out.model).toBe("gemini-3.8-flash-high");
    expect(out.request?.contents?.[0]?.parts?.[0]?.text).toBe("what is this?");
  });

  it("keeps tool declarations verbatim", () => {
    expect(out.request.tools[0].functionDeclarations[0].name).toBe("get_weather");
    expect(out.request.tools[0].functionDeclarations[0].parameters.properties.city.type).toBe("string");
  });

  it("keeps inline media and generationConfig", () => {
    expect(out.request.contents[0].parts[1].inlineData.data).toBe("AAAA");
    expect(out.request.generationConfig.responseMimeType).toBe("application/json");
  });

  it("does not leak gateway routing fields into the payload", () => {
    expect(out.request).not.toHaveProperty("model");
    expect(out.request).not.toHaveProperty("stream");
  });
});

describe("gemini → gemini-cli request", () => {
  const out = translateRequest(FORMATS.GEMINI, FORMATS.GEMINI_CLI, "gemini-2.5-flash", geminiBody(), true);

  it("hands the executor a bare GenerateContentRequest", () => {
    expect(out).not.toHaveProperty("request");
    expect(out).not.toHaveProperty("model");
    expect(out).not.toHaveProperty("stream");
    expect(out.contents[0].parts[0].text).toBe("what is this?");
    expect(out.tools[0].functionDeclarations[0].name).toBe("get_weather");
  });
});

describe("antigravity → gemini response", () => {
  it("unwraps the private-API envelope on a stream chunk", () => {
    const chunk = { response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] }, traceId: "t" };
    const out = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.GEMINI, chunk, {});
    expect(out[0].candidates[0].content.parts[0].text).toBe("hi");
    expect(out[0]).not.toHaveProperty("response");
    expect(out[0]).not.toHaveProperty("traceId");
  });

  it("passes a bare chunk through unchanged", () => {
    const chunk = { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
    const out = translateResponse(FORMATS.GEMINI_CLI, FORMATS.GEMINI, chunk, {});
    expect(out[0].candidates[0].content.parts[0].text).toBe("ok");
  });

  it("keeps functionCall parts intact", () => {
    const chunk = {
      response: {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "bj" } } }] } }],
      },
    };
    const out = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.GEMINI, chunk, {});
    expect(out[0].candidates[0].content.parts[0].functionCall.args.city).toBe("bj");
  });
});

describe("openai → gemini response (combo members on another wire)", () => {
  it("converts a text delta", () => {
    const state = {};
    const out = translateResponse(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
      state
    );
    expect(out[0].candidates[0].content.parts[0].text).toBe("hello");
  });

  it("marks reasoning as a thought part", () => {
    const out = translateResponse(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      { choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] },
      {}
    );
    expect(out[0].candidates[0].content.parts[0]).toEqual({ text: "thinking", thought: true });
  });

  it("buffers fragmented tool-call arguments and emits one functionCall", () => {
    const state = {};
    const first = translateResponse(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } }] }, finish_reason: null }] },
      state
    );
    expect(first).toEqual([]);

    const second = translateResponse(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"bj"}' } }] }, finish_reason: null }] },
      state
    );
    // fragments are still buffered — nothing complete to emit yet
    expect(second).toEqual([]);

    const done = translateResponse(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      state
    );
    const call = done[0].candidates[0].content.parts.find((p) => p.functionCall);
    expect(call.functionCall.name).toBe("get_weather");
    expect(call.functionCall.args).toEqual({ city: "bj" });
    expect(done[0].candidates[0].finishReason).toBe("STOP");
  });

  it("attaches usageMetadata on the finish chunk", () => {
    const out = translateResponse(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      {
        choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      {}
    );
    expect(out[0].usageMetadata.totalTokenCount).toBe(5);
    expect(out[0].candidates[0].finishReason).toBe("STOP");
  });

  it("converts a non-streaming completion", () => {
    const out = openAICompletionToGeminiResponse({
      model: "gpt-x",
      choices: [{
        message: {
          content: "done",
          tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a":1}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    expect(out.candidates[0].content.parts[0].text).toBe("done");
    expect(out.candidates[0].content.parts[1].functionCall).toEqual({ name: "f", args: { a: 1 } });
    expect(out.usageMetadata.totalTokenCount).toBe(2);
  });
});

describe("endpoint format detection", () => {
  it("pins /v1beta to the Gemini wire", () => {
    expect(detectFormatByEndpoint("/api/v1beta/models/x:generateContent", {})).toBe(FORMATS.GEMINI);
    expect(detectFormatByEndpoint("/v1beta/models/ag/gemini-3.8-flash-high:streamGenerateContent", {})).toBe(FORMATS.GEMINI);
  });
});
