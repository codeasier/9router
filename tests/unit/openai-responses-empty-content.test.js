/**
 * Chat Completions → Responses must never emit an empty text part.
 *
 * An assistant turn that only called tools arrives as `content: ""` from
 * clients such as opencode, which used to serialize to
 * `{ type: "output_text", text: "" }`. Volcengine Ark rejects that with
 * `MissingParameter: missing input.content.text` (400), killing the whole
 * request even though the tool call itself was well formed.
 */
import { describe, it, expect } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

const TOOL_CALL = {
  id: "call_1",
  type: "function",
  function: { name: "get_weather", arguments: '{"city":"Beijing"}' },
};

const messages = (assistantContent) => [
  { role: "user", content: "weather?" },
  { role: "assistant", content: assistantContent, tool_calls: [TOOL_CALL] },
  { role: "tool", tool_call_id: "call_1", content: "18C" },
];

const assistantMessages = (out) => out.input.filter((i) => i.type === "message" && i.role === "assistant");

describe("openai → responses: empty assistant content", () => {
  it("drops the assistant message block but keeps the tool call for content: ''", () => {
    const out = openaiToOpenAIResponsesRequest("m", { messages: messages("") }, true, null);

    expect(assistantMessages(out)).toHaveLength(0);
    // The tool call and its result still travel.
    expect(out.input.filter((i) => i.type === "function_call")).toHaveLength(1);
    expect(out.input.filter((i) => i.type === "function_call_output")).toHaveLength(1);
  });

  it("never emits a text part with an empty string", () => {
    const out = openaiToOpenAIResponsesRequest("m", { messages: messages("") }, true, null);

    for (const item of out.input) {
      if (item.type !== "message") continue;
      for (const part of item.content) {
        if (part.type === "input_text" || part.type === "output_text") {
          expect(typeof part.text).toBe("string");
          expect(part.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("treats content: '' the same as content: null", () => {
    const empty = openaiToOpenAIResponsesRequest("m", { messages: messages("") }, true, null);
    const nul = openaiToOpenAIResponsesRequest("m", { messages: messages(null) }, true, null);
    expect(empty.input).toEqual(nul.input);
  });

  it("drops empty text blocks inside array content", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      { messages: [{ role: "assistant", content: [{ type: "text", text: "" }] }] },
      true,
      null
    );
    expect(out.input).toHaveLength(0);
  });

  it("keeps non-empty text (regression)", () => {
    const out = openaiToOpenAIResponsesRequest("m", { messages: messages("let me check") }, true, null);
    const assistant = assistantMessages(out);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toEqual([{ type: "output_text", text: "let me check" }]);
  });

  it("keeps image parts even when accompanied by an empty text block", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      },
      true,
      null
    );
    expect(out.input).toHaveLength(1);
    expect(out.input[0].content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
    ]);
  });
});
