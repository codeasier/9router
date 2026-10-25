import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise translation + transformRequest only, with no SQLite/session persistence.
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    get: async () => null,
    set: async () => {},
    remove: async () => {},
    getAll: async () => ({}),
  }),
}));
vi.mock("../../open-sse/utils/sessionManager.js", () => ({
  captureSessionId: () => "1234567890",
  resolveSessionId: () => "1234567890",
  deriveSessionId: () => "1234567890",
  toNumericSessionId: (id) => id,
}));

import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import * as signatureStore from "../../open-sse/services/thoughtSignatureStore.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

afterEach(() => vi.restoreAllMocks());

const call = (name, label, id) => ({
  functionCall: { name, args: { label }, ...(id === undefined ? {} : { id }) },
});
const response = (name, value, id) => ({
  functionResponse: { name, response: value, ...(id === undefined ? {} : { id }) },
});
const modelTurn = (...parts) => ({ role: "model", parts });
const userTurn = (...parts) => ({ role: "user", parts });
const history = (...contents) => ({
  contents: [userTurn({ text: "run tools" }), ...contents],
  tools: [{ functionDeclarations: [
    { name: "alpha", parameters: { type: "object", properties: { label: { type: "string" } } } },
    { name: "beta", parameters: { type: "object", properties: { label: { type: "string" } } } },
  ] }],
});

function finalRequest(body, model = "claude-sonnet-4-6", stream = true, thinkingForce = null) {
  const credentials = { projectId: "synthetic-project", connectionId: "synthetic-connection" };
  const translated = translateRequest(FORMATS.GEMINI, FORMATS.ANTIGRAVITY, model, body, stream, credentials, "antigravity", null, [], null, null, thinkingForce);
  return new AntigravityExecutor().transformRequest(model, translated, stream, credentials);
}

function emitted(final) {
  const parts = final.request.contents.flatMap((c) => c.parts);
  return {
    parts,
    calls: parts.filter((p) => p.functionCall).map((p) => p.functionCall),
    responses: parts.filter((p) => p.functionResponse).map((p) => p.functionResponse),
  };
}

function expectPaired({ calls, responses }, expectedCalls, resultOrder) {
  expect(calls.map(({ name, args }) => [name, args.label])).toEqual(expectedCalls);
  const ids = calls.map((c) => c.id);
  expect(new Set(ids).size).toBe(calls.length);
  for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  // Labels deliberately travel in args AND results: wrong FIFO/ID matching cannot
  // pass merely by returning the right number of unique identifiers.
  expect(responses).toEqual(resultOrder.map((i) => ({
    id: calls[i].id,
    name: calls[i].name,
    response: { label: expectedCalls[i][1] },
  })));
}

describe("Gemini → Antigravity native payload preservation", () => {
  it.each([
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-6-thinking", false],
  ])("keeps native fields through translation and dispatch for %s (stream=%s)", (model, stream) => {
    const media = { inlineData: { mimeType: "image/png", data: "AAAA", displayName: "sample" }, metadata: { source: "client" } };
    const payload = {
      ...history(
        { ...modelTurn({ ...call("alpha", "one", "native_id"), thoughtSignature: "inline-native-signature", metadata: { step: 1 } }), metadata: { turn: 1 } },
        userTurn({ text: "before" }, {
          functionResponse: {
            id: "native_id", name: "alpha",
            response: { result: false, count: 0, text: "", nested: [0, false, ""] },
            scheduling: "SILENT", willContinue: false,
            parts: [media], metadata: { result: "extra" },
          },
          metadata: { step: 2 },
        }, { text: "after" }, media),
      ),
      systemInstruction: { role: "user", parts: [{ text: "be brief" }], metadata: { source: "client" } },
      generationConfig: {
        temperature: 0, topP: 0.5, maxOutputTokens: 90000,
        responseMimeType: "application/json", responseSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        stopSequences: ["END"], seed: 0,
      },
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["alpha"] } },
      safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
      cachedContent: "cachedContents/synthetic", labels: { origin: "native-client" },
    };
    payload.contents[0].parts.push(media, { fileData: { mimeType: "text/plain", fileUri: "gs://synthetic/example.txt" } });
    payload.contents[1].parts[0].functionCall.metadata = { originalCall: true };
    payload.tools[0].functionDeclarations[0].behavior = "NON_BLOCKING";
    const body = { ...payload, model: "ag/client-model", stream, stream_options: { include_usage: true }, _compact: true, proxies: {}, provider: "ag", connectionId: "client" };
    const before = structuredClone(body);
    const credentials = { projectId: "synthetic-project", connectionId: "synthetic-connection" };
    const translated = translateRequest(FORMATS.GEMINI, FORMATS.ANTIGRAVITY, model, body, stream, credentials);
    expect(translated).toEqual({ model, request: payload });
    expect(translated.request.contents).toBe(body.contents);
    expect(translated.request.tools).toBe(body.tools);
    const out = new AntigravityExecutor().transformRequest(model, translated, stream, credentials);
    expect(out.request.contents).toEqual(payload.contents);
    expect(out.request.systemInstruction).toEqual(payload.systemInstruction);
    expect(out.request.generationConfig).toEqual({ ...payload.generationConfig, maxOutputTokens: 64000 });
    expect(out.request.tools[0].functionDeclarations[0].behavior).toBe("NON_BLOCKING");
    expect(out.request).toMatchObject({ cachedContent: payload.cachedContent, labels: payload.labels, sessionId: "1234567890", toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } });
    expect(out.request.safetySettings).toBeUndefined();
    expect(out.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/);
    expect(body).toEqual(before);
  });

  it.each([false, 0, ""])("preserves all native falsy responses (%j) without wrapping/stringifying", (value) => {
    const nested = { result: value, extra: { flag: false } };
    const body = history(
      modelTurn(call("alpha", "one", "first"), call("alpha", "two", "second")),
      userTurn(response("alpha", nested, "first"), { text: "between" }, response("alpha", value, "second")),
    );
    const before = structuredClone(body);
    const final = finalRequest(body);
    expect(emitted(final).responses.map((r) => r.response)).toEqual([nested, value]);
    expect(final.request.contents[2].parts[1]).toEqual({ text: "between" });
    expect(body).toEqual(before);
  });

  it("looks up signatures by original IDs before remapping, and keeps inline signatures/extra fields", () => {
    const rawId = "signature:raw/id";
    const model = "claude-sonnet-4-6";
    const cached = vi.spyOn(signatureStore, "getGeminiThoughtSignatureSync").mockImplementation((id) => id === rawId ? "cached-original-signature" : null);
    const body = history(
      modelTurn(call("alpha", "one", rawId), { ...call("alpha", "two", rawId), thoughtSignature: "inline-original-signature", metadata: { original: true } }),
      userTurn(response("alpha", { label: "one" }, rawId), response("alpha", { label: "two" }, rawId)),
    );
    const before = structuredClone(body);
    const out = finalRequest(body, model);
    const { calls } = emitted(out);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(calls.every((c) => c.id !== rawId)).toBe(true);
    expect(out.request.contents[1].parts.map((p) => p.thoughtSignature)).toEqual(["cached-original-signature", "inline-original-signature"]);
    expect(out.request.contents[1].parts[1].metadata).toEqual({ original: true });
    expect(cached.mock.calls).toEqual([[rawId, "1234567890", model], [rawId, "1234567890", model]]);
    expect(body).toEqual(before);
  });

  it("cleans declarations and history consistently after matching raw names", () => {
    const body = history(
      modelTurn(call("read/file", "one", "dup"), call("read file", "two", "dup")),
      userTurn(response("read file", { label: "two" }, "dup"), response("read/file", { label: "one" }, "dup")),
    );
    body.tools = [{ functionDeclarations: [
      { name: "read/file", parameters: { type: "object", properties: { label: { type: "string", default: "example" } }, additionalProperties: false } },
      { name: "read file", parameters: { type: "object", properties: { label: { type: "string" } } } },
    ] }];
    const before = structuredClone(body);
    const final = finalRequest(body);
    expectPaired(emitted(final), [["read_file", "one"], ["read_file", "two"]], [1, 0]);
    expect(final.request.tools[0].functionDeclarations.map((fn) => fn.name)).toEqual(["read_file"]);
    expect(final.request.tools[0].functionDeclarations[0].parameters).toEqual({ type: "object", properties: { label: { type: "string" } } });
    expect(body).toEqual(before);
  });

  it("rewrites system branding copy-on-write and leaves the original envelope/config intact", () => {
    const body = {
      model: "claude-sonnet-4-6", stream: false, stream_options: { include_usage: true }, requestType: "agent", thinking: { type: "enabled" },
      request: {
        contents: [userTurn({ text: "hello" })],
        systemInstruction: { role: "user", metadata: { source: "client" }, parts: [{ text: "OpenCode and opencode", metadata: { index: 0 } }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
        generationConfig: { temperature: 0, maxOutputTokens: 90000 },
      },
    };
    const before = structuredClone(body);
    const out = new AntigravityExecutor().transformRequest(body.model, body, false, { projectId: "synthetic-project" });
    expect(out.request.systemInstruction).toEqual({ ...before.request.systemInstruction, parts: [{ text: "Antigravity and antigravity", metadata: { index: 0 } }, before.request.systemInstruction.parts[1]] });
    expect(out.request.generationConfig).toEqual({ temperature: 0, maxOutputTokens: 64000 });
    expect(out).not.toHaveProperty("stream_options");
    expect(out).not.toHaveProperty("stream");
    expect(out).not.toHaveProperty("requestType");
    expect(out).not.toHaveProperty("thinking");
    expect(body).toEqual(before);
  });

  it("isolates generationConfig from shared thinking post-processing without mutating client input", () => {
    const body = history(userTurn({ text: "hello" }));
    body.generationConfig = { temperature: 0, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 1024 }, responseMimeType: "application/json" };
    const before = structuredClone(body);
    finalRequest(body, "claude-opus-4-6-thinking", false);
    expect(body).toEqual(before);
  });

  it("keeps native Gemini opaque IDs untouched", () => {
    const body = history(
      modelTurn(call("alpha", "one", "opaque:id/with.dots")),
      userTurn(response("alpha", { label: "one" }, "opaque:id/with.dots")),
    );
    const out = emitted(finalRequest(body, "gemini-3.8-flash-tiered", false));
    expect(out.calls[0].id).toBe("opaque:id/with.dots");
    expect(out.responses[0].id).toBe("opaque:id/with.dots");
  });

  it("keeps unknown explicit results isolated without consuming another explicit call", () => {
    const body = history(
      modelTurn(call("alpha", "known", "known")),
      userTurn(response("alpha", { label: "orphan" }, "unknown"), response("alpha", { label: "known" }, "known")),
    );
    const out = emitted(finalRequest(body));
    expect(out.responses).toEqual([
      { id: "unknown", name: "alpha", response: { label: "orphan" } },
      { id: "known", name: "alpha", response: { label: "known" } },
    ]);
  });

  it("retains initial/terminal user normalization and generates a paired continuation result", () => {
    const body = { contents: [modelTurn(call("alpha", "one"))] };
    const before = structuredClone(body);
    const final = finalRequest(body);
    expect(final.request.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    const { calls, responses } = emitted(final);
    expect(calls[0].id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(final.request.contents[1].parts[0].thoughtSignature).toBe(DEFAULT_THINKING_AG_SIGNATURE);
    expect(responses).toEqual([{ id: calls[0].id, name: "alpha", response: { result: "Continue." } }]);
    expect(body).toEqual(before);
  });
});

describe("Antigravity optional roles and Google-wire thinking", () => {
  it.each([
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-6-thinking", false],
  ])("defaults role-less text/media to user for %s (stream=%s)", (model, stream) => {
    const body = { contents: [{ parts: [{ text: "keep-me" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] }] };
    const before = structuredClone(body);
    const wire = JSON.parse(JSON.stringify(finalRequest(body, model, stream)));
    expect(wire.request.contents).toEqual([{ ...before.contents[0], role: "user" }]);
    expect(body).toEqual(before);
  });

  it("infers missing call/result roles and keeps explicit text roles", () => {
    const body = { contents: [
      userTurn({ text: "explicit user" }),
      { parts: [call("alpha", "one")] },
      { parts: [response("alpha", { label: "one" })] },
      modelTurn({ text: "explicit model" }),
      { parts: [{ text: "implicit user" }] },
    ] };
    const before = structuredClone(body);
    const wire = finalRequest(body);
    expect(wire.request.contents.map((c) => c.role)).toEqual(["user", "model", "user", "model", "user"]);
    expectPaired(emitted(wire), [["alpha", "one"]], [0]);
    expect(body).toEqual(before);
  });

  it.each([
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-6-thinking", false],
  ])("corrects explicit model results to user without an artificial continuation for %s", (model, stream) => {
    const body = history(
      modelTurn(call("alpha", "one", "native_call")),
      modelTurn(response("alpha", { label: "one" }, "native_call")),
    );
    const before = structuredClone(body);
    const wire = JSON.parse(JSON.stringify(finalRequest(body, model, stream)));
    expect(wire.request.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expectPaired(emitted(wire), [["alpha", "one"]], [0]);
    expect(wire.request.contents[2].parts).toEqual(before.contents[2].parts);
    expect(body).toEqual(before);
  });

  it.each(["claude-sonnet-4-6", "claude-opus-4-6-thinking"])("keeps native thinkingConfig including includeThoughts=false and extra fields for %s", (model) => {
    const thinkingConfig = { thinkingBudget: 1024, includeThoughts: false, futureOption: { enabled: false } };
    const body = { contents: [userTurn({ text: "hello" })], generationConfig: { temperature: 0, responseMimeType: "application/json", thinkingConfig } };
    const before = structuredClone(body);
    const wire = JSON.parse(JSON.stringify(finalRequest(body, model, false)));
    expect(wire.request.generationConfig).toEqual(before.generationConfig);
    expect(wire).not.toHaveProperty("thinking");
    expect(wire).not.toHaveProperty("output_config");
    expect(body).toEqual(before);
    expect(thinkingConfig).toEqual(before.generationConfig.thinkingConfig);
  });

  it.each([
    { name: "gateway level overrides native budget", model: "claude-sonnet-4-6", force: { mode: "level", level: "high", force: true }, expected: { thinkingBudget: 24576, includeThoughts: true } },
    { name: "model suffix overrides native budget", model: "claude-opus-4-6-thinking(high)", expected: { thinkingBudget: 24576, includeThoughts: true } },
    { name: "gateway budget beats a model suffix", model: "claude-sonnet-4-6(high)", force: { mode: "budget", budget: 4096, force: true }, expected: { thinkingBudget: 4096, includeThoughts: true } },
    { name: "numeric suffix beats unforced intent", model: "claude-opus-4-6-thinking(8192)", force: { mode: "budget", budget: 4096 }, expected: { thinkingBudget: 8192, includeThoughts: true } },
    { name: "gateway off beats a model suffix", model: "claude-sonnet-4-6(high)", force: { mode: "none", force: true }, expected: { thinkingBudget: 0, includeThoughts: false } },
    { name: "Gemini level caps keep their Google level mapping", model: "gemini-3.8-flash", force: { mode: "level", level: "high", force: true }, expected: { thinkingLevel: "high", includeThoughts: true } },
    { name: "Gemini budget caps still clamp overrides", model: "gemini-2.5-flash", force: { mode: "budget", budget: 999999, force: true }, expected: { thinkingBudget: 24576, includeThoughts: true } },
  ])("emits Google thinking fields when $name", ({ model, force, expected }) => {
    const thinkingConfig = { thinkingBudget: 1024, includeThoughts: false };
    const body = { contents: [userTurn({ text: "hello" })], generationConfig: { temperature: 0, thinkingConfig } };
    const before = structuredClone(body);
    const wire = JSON.parse(JSON.stringify(finalRequest(body, model, false, force)));
    expect(wire.request.generationConfig.thinkingConfig).toEqual(expected);
    expect(wire.request.generationConfig.temperature).toBe(0);
    expect(wire).not.toHaveProperty("thinking");
    expect(wire).not.toHaveProperty("output_config");
    expect(body).toEqual(before);
    expect(thinkingConfig).toEqual(before.generationConfig.thinkingConfig);
  });

  it("does not bypass non-reasoning caps when retaining native config", () => {
    const body = { contents: [userTurn({ text: "hello" })], generationConfig: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: false } } };
    const before = structuredClone(body);
    const wire = finalRequest(body, "gpt-4o", false);
    expect(wire.request.generationConfig.thinkingConfig).toBeUndefined();
    expect(body).toEqual(before);
  });
});

describe("Gemini → Antigravity Claude final requests", () => {
  it.each([
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-6-thinking", false],
  ])("pairs parallel and multi-round ID-less calls for %s (stream=%s)", (model, stream) => {
    const body = history(
      modelTurn({ text: "calling" }, call("alpha", "first"), call("alpha", "second")),
      userTurn(response("alpha", { label: "first" }), { text: "between results" }, response("alpha", { label: "second" }), { text: "next round" }),
      modelTurn(call("alpha", "third")),
      userTurn(response("alpha", { label: "third" }), { text: "done" }),
    );
    const before = structuredClone(body);
    const final = finalRequest(body, model, stream);
    const out = emitted(final);
    expect(final.model).toBe(model);
    expectPaired(out, [["alpha", "first"], ["alpha", "second"], ["alpha", "third"]], [0, 1, 2]);
    const callParts = out.parts.filter((p) => p.functionCall);
    expect(callParts.map((p) => p.thoughtSignature)).toEqual([DEFAULT_THINKING_AG_SIGNATURE, undefined, DEFAULT_THINKING_AG_SIGNATURE]);
    expect(out.parts.filter((p) => p.text).map((p) => p.text)).toEqual([
      "run tools", "calling", "between results", "next round", "done",
    ]);
    const mixedTurn = final.request.contents[2].parts;
    expect(mixedTurn.map((p) => p.text || p.functionResponse?.response.label)).toEqual([
      "first", "between results", "second", "next round",
    ]);
    expect(emitted(finalRequest(body, model, stream)).calls).toEqual(out.calls);
    expect(body).toEqual(before);
  });

  const positionalId = "call_msg1_tc0_alpha";
  const cases = [
    {
      name: "preserves unique explicit IDs and matches out-of-order parallel results",
      contents: [
        modelTurn(call("alpha", "a", "keep_a"), call("alpha", "b", "keep_b"), call("beta", "c", "keep_c")),
        userTurn(response("beta", { label: "c" }, "keep_c"), response("alpha", { label: "b" }, "keep_b"), response("alpha", { label: "a" }, "keep_a")),
      ],
      calls: [["alpha", "a"], ["alpha", "b"], ["beta", "c"]], order: [2, 1, 0],
      preserved: { 0: "keep_a", 1: "keep_b", 2: "keep_c" },
    },
    {
      name: "remaps duplicate same-name IDs within one turn using FIFO",
      contents: [
        modelTurn(call("alpha", "a", "dup"), call("alpha", "b", "dup"), call("alpha", "c", "dup")),
        userTurn(response("alpha", { label: "a" }, "dup"), response("alpha", { label: "b" }, "dup"), response("alpha", { label: "c" }, "dup")),
      ],
      calls: [["alpha", "a"], ["alpha", "b"], ["alpha", "c"]], order: [0, 1, 2], preserved: { 0: "dup" },
    },
    {
      name: "remaps duplicate IDs across rounds without reusing consumed calls",
      contents: [
        modelTurn(call("alpha", "a", "dup")), userTurn(response("alpha", { label: "a" }, "dup")),
        modelTurn(call("alpha", "b", "dup")), userTurn(response("alpha", { label: "b" }, "dup")),
      ],
      calls: [["alpha", "a"], ["alpha", "b"]], order: [0, 1], preserved: { 0: "dup" },
    },
    {
      name: "disambiguates duplicate IDs by tool name even when results are reversed",
      contents: [
        modelTurn(call("alpha", "a", "shared"), call("beta", "b", "shared")),
        userTurn(response("beta", { label: "b" }, "shared"), response("alpha", { label: "a" }, "shared")),
      ],
      calls: [["alpha", "a"], ["beta", "b"]], order: [1, 0], preserved: { 0: "shared" },
    },
    {
      name: "matches raw IDs through sanitization collisions and reserves later valid IDs",
      contents: [
        modelTurn(call("alpha", "a", "a:b"), call("alpha", "b", "ab"), call("alpha", "c", "a.b"), call("beta", "d", "!!!")),
        userTurn(response("alpha", { label: "c" }, "a.b"), response("beta", { label: "d" }, "!!!"), response("alpha", { label: "b" }, "ab"), response("alpha", { label: "a" }, "a:b")),
      ],
      calls: [["alpha", "a"], ["alpha", "b"], ["alpha", "c"], ["beta", "d"]], order: [2, 3, 1, 0], preserved: { 1: "ab" },
    },
    {
      name: "does not collide when two invalid raw IDs sanitize to the same value",
      contents: [
        modelTurn(call("alpha", "a", "a:b"), call("alpha", "b", "a.b")),
        userTurn(response("alpha", { label: "b" }, "a.b"), response("alpha", { label: "a" }, "a:b")),
      ],
      calls: [["alpha", "a"], ["alpha", "b"]], order: [1, 0], preserved: {},
    },
    {
      name: "reserves explicit IDs in later rounds, including a generated collision suffix",
      contents: [
        modelTurn(call("alpha", "a")), userTurn(response("alpha", { label: "a" })),
        modelTurn(call("alpha", "b", positionalId), call("beta", "c", `${positionalId}_1`)),
        userTurn(response("beta", { label: "c" }, `${positionalId}_1`), response("alpha", { label: "b" }, positionalId)),
      ],
      calls: [["alpha", "a"], ["alpha", "b"], ["beta", "c"]], order: [0, 2, 1],
      preserved: { 1: positionalId, 2: `${positionalId}_1` },
    },
    {
      name: "matches ID-less results to explicit calls by name and FIFO",
      contents: [
        modelTurn(call("alpha", "a", "first"), call("alpha", "b", "second"), call("beta", "c", "third")),
        userTurn(response("beta", { label: "c" }), response("alpha", { label: "a" }), response("alpha", { label: "b" })),
      ],
      calls: [["alpha", "a"], ["alpha", "b"], ["beta", "c"]], order: [2, 0, 1],
      preserved: { 0: "first", 1: "second", 2: "third" },
    },
    {
      name: "matches result-only IDs to same-name ID-less calls",
      contents: [
        modelTurn(call("alpha", "a"), call("beta", "b")),
        userTurn(response("beta", { label: "b" }, "result_b"), response("alpha", { label: "a" }, "result_a")),
      ],
      calls: [["alpha", "a"], ["beta", "b"]], order: [1, 0], preserved: {},
    },
    {
      name: "prioritizes a matching raw explicit ID over an earlier ID-less call",
      contents: [
        modelTurn(call("alpha", "a"), call("alpha", "b", "explicit")),
        userTurn(response("alpha", { label: "b" }, "explicit"), response("alpha", { label: "a" }, "legacy_result")),
      ],
      calls: [["alpha", "a"], ["alpha", "b"]], order: [1, 0], preserved: { 1: "explicit" },
    },
    {
      name: "does not let a sanitized ID shadow another call's raw explicit ID",
      contents: [
        modelTurn(call("alpha", "a", "a:b"), call("alpha", "b")),
        userTurn(response("alpha", { label: "b" }, "ab"), response("alpha", { label: "a" }, "a:b")),
      ],
      calls: [["alpha", "a"], ["alpha", "b"]], order: [1, 0], preserved: {},
    },
  ];

  it.each(cases)("$name", ({ contents, calls, order, preserved }) => {
    const body = history(...contents);
    const before = structuredClone(body);
    const out = emitted(finalRequest(body));
    expectPaired(out, calls, order);
    for (const [i, id] of Object.entries(preserved)) expect(out.calls[i].id).toBe(id);
    expect(emitted(finalRequest(body)).calls).toEqual(out.calls);
    expect(body).toEqual(before);
  });
});
