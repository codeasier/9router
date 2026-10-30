import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { getModelMeta, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const model = "gpt-6.1-sol-parallel";
const upstreamModel = "gpt-6.1-sol";
const credentials = { connectionId: "parallel-fixture", accessToken: "fixture-token" };
const tool = { type: "function", name: "get_time", parameters: { type: "object", properties: {} } };

afterEach(() => vi.restoreAllMocks());

async function send(requestedModel, body) {
  const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async () => new Response("", { status: 200 }));
  const executor = new CodexExecutor();
  await executor.execute({ model: requestedModel, body, stream: true, credentials });
  const [, options] = fetchMock.mock.calls.at(-1);
  return { executor, headers: options.headers, body: JSON.parse(options.body) };
}

describe("Codex optional parallel Responses transport (#36)", () => {
  it("registers an opt-in transport alias with the same model limits, effort levels and price", () => {
    expect(getModelMeta("cx", model)).toMatchObject({ upstreamModelId: upstreamModel, responsesLite: false });
    expect(getModelUpstreamId("cx", `${model}(high)`)).toBe(`${upstreamModel}(high)`);
    expect(getCapabilitiesForModel("codex", model)).toEqual(getCapabilitiesForModel("codex", upstreamModel));
    expect(getThinkingLevels("codex", model)).toEqual(getThinkingLevels("codex", upstreamModel));
    expect(getPricingForModel("codex", model)).toEqual(getPricingForModel("codex", upstreamModel));
  });

  it.each([model, upstreamModel])("uses regular Responses when translation has set body.model=%s", async (bodyModel) => {
    const { headers, body } = await send(model, {
      model: bodyModel, input: "Call the tools", instructions: "Do the task", tools: [structuredClone(tool)],
      parallel_tool_calls: true, reasoning: { effort: "high" },
    });
    expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(body).toMatchObject({
      model: upstreamModel, instructions: "Do the task", tools: [tool], parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" }, store: false, stream: true,
    });
    expect(body.reasoning).not.toHaveProperty("context");
    expect(body.input.some(item => item.type === "additional_tools")).toBe(false);
  });

  it("honors transport metadata on a thinking-suffixed alias", async () => {
    const { headers, body } = await send(`${model}(max)`, {
      model: upstreamModel, input: "hello", reasoning: { effort: "max" }, parallel_tool_calls: true,
    });
    expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(body.model).toBe(upstreamModel);
    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(body.parallel_tool_calls).toBe(true);
  });

  it.each([model, "gpt-6-astra"])("preserves explicit false and an omitted parallel setting on %s", async (requestedModel) => {
    const first = await send(requestedModel, { input: "hello", parallel_tool_calls: false });
    expect(first.body.parallel_tool_calls).toBe(false);
    const second = await send(requestedModel, { input: "hello" });
    expect(second.body).not.toHaveProperty("parallel_tool_calls");
  });

  it("keeps the original Sol model on Lite even when parallel calls are requested", async () => {
    const { headers, body } = await send(upstreamModel, {
      model: upstreamModel, input: "hello", tools: [structuredClone(tool)], parallel_tool_calls: true,
    });
    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tools).toBeNull();
    expect(body.input[0]).toMatchObject({ type: "additional_tools", tools: [tool] });
    expect(body.reasoning.context).toBe("all_turns");
  });

  it("promotes native Lite tools when the alias selects regular Responses", async () => {
    const instruction = { type: "message", id: "msg_native", role: "developer", content: [{ type: "input_text", text: "Only answer in French" }] };
    const { headers, body } = await send(model, {
      model: upstreamModel, tools: [structuredClone(tool)], instructions: "", parallel_tool_calls: true,
      reasoning: { effort: "high", context: "all_turns" },
      input: [
        { type: "additional_tools", role: "developer", tools: [structuredClone(tool), { type: "custom", name: "shell", format: { type: "text" } }] },
        instruction,
        { role: "user", content: "hello" },
      ],
    });
    expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(body.tools).toEqual([tool, { type: "custom", name: "shell", format: { type: "text" } }]);
    expect(body.input.some(item => item.type === "additional_tools")).toBe(false);
    expect(body.input[0]).toEqual({ ...instruction, id: undefined });
    expect(body.instructions).toBe("");
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("preserves parallel permission when hosted search switches a Lite model to regular Responses", async () => {
    const { headers, body } = await send(upstreamModel, {
      input: "search", tools: [{ type: "web_search" }], parallel_tool_calls: true,
    });
    expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("retains both tool calls, results and encrypted reasoning on the next request", async () => {
    const calls = ["tokyo", "london"].map(city => ({
      type: "function_call", id: `fc_${city}`, call_id: `call_${city}`, name: "get_time", arguments: JSON.stringify({ city }),
    }));
    const outputs = calls.map(call => ({ type: "function_call_output", call_id: call.call_id, output: "12:00" }));
    const { body } = await send(model, {
      model: upstreamModel, parallel_tool_calls: true, tools: [structuredClone(tool)], input: [
        { role: "user", content: "Get both times" },
        { type: "reasoning", id: "rs_previous", encrypted_content: "encrypted-fixture", summary: [] },
        ...calls, ...outputs,
      ],
    });
    expect(body.input.filter(item => item.type === "function_call")).toEqual(calls.map(({ id, ...call }) => call));
    expect(body.input.filter(item => item.type === "function_call_output")).toEqual(outputs);
    expect(body.input.find(item => item.type === "reasoning")).toMatchObject({ encrypted_content: "encrypted-fixture" });
  });

  it("keeps header and body aligned when retrying an already-transformed request", async () => {
    const request = { model: upstreamModel, input: "hello", parallel_tool_calls: true, tools: [structuredClone(tool)] };
    const { executor } = await send(model, request);
    await executor.execute({ model, body: request, stream: true, credentials });
    const [, options] = proxyFetchModule.proxyAwareFetch.mock.calls.at(-1);
    expect(options.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(JSON.parse(options.body)).toMatchObject({ model: upstreamModel, tools: [tool], parallel_tool_calls: true });
  });
});
