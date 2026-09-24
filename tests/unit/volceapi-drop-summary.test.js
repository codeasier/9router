import { afterEach, describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  sanitizeDropResponsesReasoningSummary,
  setCustomModelFormatOverlay,
} from "../../open-sse/config/customModelFormats.js";
import { getModelDropResponsesReasoningSummary } from "../../open-sse/config/providerModels.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

afterEach(() => {
  setCustomModelFormatOverlay([]);
});

describe("volceapi dropResponsesReasoningSummary", () => {
  it("sanitizes the model-level flag", () => {
    expect(sanitizeDropResponsesReasoningSummary(true)).toBe(true);
    expect(sanitizeDropResponsesReasoningSummary(false)).toBe(false);
    expect(sanitizeDropResponsesReasoningSummary("true")).toBe(false);
    expect(sanitizeDropResponsesReasoningSummary(1)).toBe(false);
  });

  it("reads the flag from the custom model overlay", () => {
    setCustomModelFormatOverlay([
      {
        providerAlias: "volceapi",
        id: "deepseek-v4.1-flash",
        type: "llm",
        dropResponsesReasoningSummary: true,
      },
      {
        providerAlias: "volceapi",
        id: "glm-5.3",
        type: "llm",
        dropResponsesReasoningSummary: false,
      },
    ]);

    expect(getModelDropResponsesReasoningSummary("volceapi", "deepseek-v4.1-flash")).toBe(true);
    expect(getModelDropResponsesReasoningSummary("volceapi", "deepseek-v4.1-flash(high)")).toBe(true);
    expect(getModelDropResponsesReasoningSummary("volceapi", "glm-5.3")).toBe(false);
    expect(getModelDropResponsesReasoningSummary("volceapi", "kimi-k3")).toBe(false);
  });

  it("drops only top-level reasoning.summary on Responses requests", () => {
    setCustomModelFormatOverlay([
      {
        providerAlias: "volceapi",
        id: "deepseek-v4.1-flash",
        type: "llm",
        dropResponsesReasoningSummary: true,
      },
    ]);

    const executor = new DefaultExecutor("volceapi");
    const body = {
      model: "deepseek-v4.1-flash",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      reasoning: { effort: "low", summary: "auto" },
    };

    const out = executor.transformRequest("deepseek-v4.1-flash", body, false, {
      runtimeTransport: { format: FORMATS.OPENAI_RESPONSES },
    });

    expect(out.reasoning).toEqual({ effort: "low" });
  });

  it("preserves input item summaries when dropping the top-level flag", () => {
    setCustomModelFormatOverlay([
      {
        providerAlias: "volceapi",
        id: "deepseek-v4.1-flash",
        type: "llm",
        dropResponsesReasoningSummary: true,
      },
    ]);

    const executor = new DefaultExecutor("volceapi");
    const inputSummary = [{ type: "summary_text", text: "kept" }];
    const body = {
      model: "deepseek-v4.1-flash",
      input: [
        { type: "reasoning", summary: inputSummary },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      reasoning: { effort: "low", summary: "auto" },
    };

    const out = executor.transformRequest("deepseek-v4.1-flash", body, false, {
      runtimeTransport: { format: FORMATS.OPENAI_RESPONSES },
    });

    expect(out.input[0].summary).toBe(inputSummary);
    expect(out.reasoning).toEqual({ effort: "low" });
  });

  it("keeps reasoning.summary when the model opts out", () => {
    setCustomModelFormatOverlay([
      {
        providerAlias: "volceapi",
        id: "glm-5.3",
        type: "llm",
        dropResponsesReasoningSummary: false,
      },
    ]);

    const executor = new DefaultExecutor("volceapi");
    const body = {
      model: "glm-5.3",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      reasoning: { effort: "low", summary: "auto" },
    };

    const out = executor.transformRequest("glm-5.3", body, false, {
      runtimeTransport: { format: FORMATS.OPENAI_RESPONSES },
    });

    expect(out.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("does not apply the Responses cleanup on chat requests", () => {
    setCustomModelFormatOverlay([
      {
        providerAlias: "volceapi",
        id: "deepseek-v4.1-flash",
        type: "llm",
        dropResponsesReasoningSummary: true,
      },
    ]);

    const executor = new DefaultExecutor("volceapi");
    const body = {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "low", summary: "auto" },
    };

    const out = executor.transformRequest("deepseek-v4.1-flash", body, false, {
      runtimeTransport: { format: FORMATS.OPENAI },
    });

    expect(out.reasoning).toEqual({ effort: "low", summary: "auto" });
  });
});
