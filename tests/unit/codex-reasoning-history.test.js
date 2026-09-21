import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const model = "gpt-5.5";
const credentials = { connectionId: "test-reasoning-history" };

function transform(body, executor = new CodexExecutor()) {
  return executor.transformRequest(model, body, true, credentials);
}

describe("Codex reasoning history compatibility", () => {
  it.each([{ summary: undefined }, { summary: [] }])("promotes polluted reasoning content with summary $summary", ({ summary }) => {
    const item = {
      type: "reasoning",
      id: "rs_previous_provider",
      encrypted_content: null,
      content: [
        { type: "reasoning_text", text: "  First step\n" },
        { type: "reasoning_text", text: "Second step" },
      ],
      ...(summary === undefined ? {} : { summary }),
    };

    const result = transform({ model, input: [item] });

    expect(result.input).toEqual([{
      type: "reasoning",
      content: [],
      encrypted_content: null,
      summary: [
        { type: "summary_text", text: "  First step\n" },
        { type: "summary_text", text: "Second step" },
      ],
    }]);
  });

  it("preserves existing summary and encrypted content instead of appending raw reasoning", () => {
    const summary = [{ type: "summary_text", text: "Existing summary" }];
    const item = {
      type: "reasoning",
      summary,
      encrypted_content: "opaque-encrypted-history",
      status: "completed",
      content: [{ type: "reasoning_text", text: "Do not append" }],
    };

    const result = transform({ model, input: [item] });

    expect(result.input[0]).toEqual({ ...item, content: [] });
    expect(result.input[0].summary).toBe(summary);
  });

  it("promotes only reasoning_text blocks with string text, without trimming", () => {
    const result = transform({ model, input: [{
      type: "reasoning",
      content: [
        null, {}, "not a block",
        { type: "reasoning_text" },
        { type: "reasoning_text", text: 42 },
        { type: "reasoning_text", text: null },
        { type: "output_text", text: "Not reasoning" },
        { type: "reasoning_text", text: "" },
        { type: "reasoning_text", text: " \n " },
      ],
    }] });

    expect(result.input[0]).toEqual({
      type: "reasoning",
      content: [],
      summary: [
        { type: "summary_text", text: "" },
        { type: "summary_text", text: " \n " },
      ],
    });
  });

  it("clears unsupported content even when no text can be promoted", () => {
    const result = transform({ model, input: [{
      type: "reasoning", summary: [], encrypted_content: "opaque",
      content: [{ type: "output_text", text: "Not reasoning" }],
    }] });
    expect(result.input[0]).toEqual({
      type: "reasoning", summary: [], encrypted_content: "opaque", content: [],
    });
  });

  it("leaves messages and function/custom tool history unchanged", () => {
    const input = [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "Think" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
      { type: "custom_tool_call", call_id: "call_2", name: "shell", input: "pwd" },
      { type: "custom_tool_call_output", call_id: "call_2", output: "workspace" },
    ];
    const snapshot = structuredClone(input);

    expect(transform({ model, input }).input.slice(1)).toEqual(snapshot.slice(1));
    expect(input).toEqual(snapshot);
  });

  it("does not mutate shared original history across shallow clones and repeated calls", () => {
    const original = { model, input: [
      { type: "message", id: "msg_system", role: "system", content: "Instructions" },
      { type: "reasoning", id: "rs_old", summary: [], encrypted_content: "opaque",
        content: [{ type: "reasoning_text", text: "Original reasoning" }] },
      { type: "function_call", id: "fc_old", call_id: "call_1", name: "lookup", arguments: "{}" },
    ] };
    const snapshot = structuredClone(original);
    const input = original.input;
    const executor = new CodexExecutor();

    const first = transform({ ...original }, executor);
    const second = transform({ ...original }, executor);
    const repeated = transform({ ...first }, executor);

    expect(original).toEqual(snapshot);
    expect(original.input).toBe(input);
    expect(first.input).not.toBe(input);
    expect(first.input[1]).not.toBe(input[1]);
    expect(first.input[1].content).not.toBe(input[1].content);
    expect(first.input[1].summary).not.toBe(input[1].summary);
    expect(second.input).toEqual(first.input);
    expect(repeated.input).toEqual(first.input);
    expect(first.input[0].role).toBe("developer");
    expect(first.input.every((item) => item.id === undefined)).toBe(true);

    const compatible = new DefaultExecutor("openai-compatible-history");
    const compatibleResult = compatible.transformRequest(model, { ...original });
    expect(compatibleResult.input).toBe(input);
    expect(compatibleResult.input).toEqual(snapshot.input);
  });

  it.each([{ content: undefined }, { content: [] }, { content: null }])("leaves reasoning with content $content unchanged", ({ content }) => {
    const item = {
      type: "reasoning", summary: [{ type: "summary_text", text: "Native summary" }],
      encrypted_content: "opaque",
      ...(content === undefined ? {} : { content }),
    };
    expect(transform({ model, input: [item] }).input).toEqual([item]);
  });
});
