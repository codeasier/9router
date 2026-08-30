import { describe, expect, it } from "vitest";

const { openaiToOpenAIResponsesRequest, openaiResponsesToOpenAIRequest } =
  await import("../../open-sse/translator/request/openai-responses.js");

const CHAT_BODY = (extra = {}) => ({
  model: "example-model",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

describe("#3216 prompt_cache_key across the chat/responses translation", () => {
  it("preserves an explicit key when converting chat → responses", () => {
    const out = openaiToOpenAIResponsesRequest(
      "example-model",
      CHAT_BODY({ prompt_cache_key: "stable-cache-key" }),
      true,
      {},
    );

    expect(out.prompt_cache_key).toBe("stable-cache-key");
  });

  it("does not invent a key when the client sent none", () => {
    const out = openaiToOpenAIResponsesRequest("example-model", CHAT_BODY(), true, {});

    expect(out.prompt_cache_key).toBeUndefined();
  });

  it("maps chat max_tokens to Responses max_output_tokens", () => {
    const out = openaiToOpenAIResponsesRequest(
      "example-model",
      CHAT_BODY({ max_tokens: 1024 }),
      false,
      {},
    );

    expect(out.max_output_tokens).toBe(1024);
    expect(out.max_tokens).toBeUndefined();
    expect(out.stream).toBe(false);
  });

  it("still drops the key on the responses → chat direction", () => {
    const out = openaiResponsesToOpenAIRequest(
      "example-model",
      {
        model: "example-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        prompt_cache_key: "stable-cache-key",
      },
      true,
      {},
    );

    expect(out.prompt_cache_key).toBeUndefined();
  });
});
