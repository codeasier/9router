import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseBlock(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("yields at the first reasoning delta instead of holding the thinking phase", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    // Open-ended upstream: the reasoning phase started, no answer text arrived yet.
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          sseBlock("response.created", { type: "response.created", response: { id: "resp_1" } }),
          sseBlock("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
          sseBlock("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } }),
          sseBlock("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "thinking..." }),
        ].join("")));
      },
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await withTimeout(
      executor._peekSseTransientError(response),
      1000,
      "peek held the reasoning phase waiting for answer text",
    );
    expect(peek.matched).toBeNull();
    await peek.replacementBody?.cancel?.();
  });

  it("replays the reasoning prefix plus the rest of the stream without loss", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    const prefix = sseBlock("response.created", { type: "response.created", response: { id: "resp_2" } })
      + sseBlock("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: "rs_2", summary_index: 0, delta: "thinking..." });
    const answer = sseBlock("response.output_text.delta", { type: "response.output_text.delta", delta: "Hi!" });

    let upstream;
    const response = new Response(new ReadableStream({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode(prefix));
      },
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await withTimeout(
      executor._peekSseTransientError(response),
      1000,
      "peek held the reasoning phase waiting for answer text",
    );
    expect(peek.matched).toBeNull();

    upstream.enqueue(encoder.encode(answer));
    upstream.close();

    await expect(new Response(peek.replacementBody).text()).resolves.toBe(prefix + answer);
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});
