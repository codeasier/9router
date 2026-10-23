// OpenAI → Gemini (client side).
//
// The Gemini endpoint is a Gemini client wire: a combo may still route one of its
// members to an OpenAI-shaped provider, and such a member answers in Chat
// Completions SSE/JSON. This pair converts that answer back so a Gemini client
// sees `candidates[].content.parts` — including functionCall parts, which the
// endpoint's previous hand-rolled converter dropped.
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

const FINISH_TO_GEMINI = {
  stop: "STOP",
  length: "MAX_TOKENS",
  max_tokens: "MAX_TOKENS",
  tool_calls: "STOP",
  function_call: "STOP",
  content_filter: "SAFETY",
  safety: "SAFETY",
  recitation: "RECITATION",
  other: "OTHER"
};

function mapFinish(reason) {
  if (!reason) return "STOP";
  return FINISH_TO_GEMINI[String(reason).toLowerCase()] || "STOP";
}

function safeParseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** OpenAI usage → Gemini usageMetadata (usage is already normalised by the engine). */
export function openAIToGeminiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  if (!prompt && !completion && !total) return null;
  const meta = {
    promptTokenCount: prompt,
    candidatesTokenCount: completion,
    totalTokenCount: total
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached) meta.cachedContentTokenCount = cached;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning) meta.thoughtsTokenCount = reasoning;
  return meta;
}

function messageParts(message) {
  const parts = [];
  if (message?.reasoning_content) parts.push({ text: message.reasoning_content, thought: true });
  if (typeof message?.content === "string" && message.content) parts.push({ text: message.content });
  else if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block?.type === "text" && block.text) parts.push({ text: block.text });
    }
  }
  for (const call of message?.tool_calls || []) {
    parts.push({
      functionCall: {
        name: call.function?.name || "unknown",
        args: safeParseArgs(call.function?.arguments)
      }
    });
  }
  return parts;
}

/**
 * Streaming: one OpenAI chunk → one Gemini chunk.
 * Tool calls arrive fragmented (`arguments` deltas); Gemini needs one complete
 * functionCall, so fragments are buffered in `state` and flushed on finish.
 */
export function openaiChunkToGemini(chunk, state) {
  if (chunk === null || chunk === undefined) {
    // Flush: emit any tool calls that never saw a finish_reason.
    const pending = state?._geminiToolCalls;
    if (!pending?.length) return null;
    state._geminiToolCalls = [];
    const parts = pending
      .filter((call) => call?.name)
      .map((call) => ({ functionCall: { name: call.name, args: safeParseArgs(call.args) } }));
    if (!parts.length) return null;
    return [{
      candidates: [{
        content: { role: "model", parts },
        finishReason: "STOP",
        index: 0
      }]
    }];
  }

  if (chunk.done) return null;

  const choice = chunk.choices?.[0];
  if (!choice) {
    // Usage-only trailer (stream_options.include_usage).
    const usage = openAIToGeminiUsage(chunk.usage);
    return usage ? [{ usageMetadata: usage }] : null;
  }

  const delta = choice.delta || {};

  if (Array.isArray(delta.tool_calls)) {
    if (!state) return null;
    state._geminiToolCalls ||= [];
    for (const call of delta.tool_calls) {
      const index = call.index ?? state._geminiToolCalls.length;
      const slot = (state._geminiToolCalls[index] ||= { name: "", args: "" });
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.args += call.function.arguments;
    }
  }

  const parts = [];
  if (delta.reasoning_content) parts.push({ text: delta.reasoning_content, thought: true });
  if (delta.content) parts.push({ text: delta.content });

  const finish = choice.finish_reason ? mapFinish(choice.finish_reason) : null;

  if (finish && state?._geminiToolCalls?.length) {
    for (const call of state._geminiToolCalls) {
      if (call?.name) parts.push({ functionCall: { name: call.name, args: safeParseArgs(call.args) } });
    }
    state._geminiToolCalls = [];
  }

  if (!parts.length && !finish) return null;

  const candidate = {
    content: { role: "model", parts: parts.length ? parts : [{ text: "" }] },
    index: 0
  };
  if (finish) candidate.finishReason = finish;

  const out = { candidates: [candidate] };
  const usage = openAIToGeminiUsage(chunk.usage);
  if (usage) out.usageMetadata = usage;
  return [out];
}

/** Non-streaming: Chat Completions JSON → GenerateContentResponse. */
export function openAICompletionToGeminiResponse(body) {
  if (!body || body.candidates) return body;
  const choice = body.choices?.[0];
  if (!choice) return body;

  const parts = messageParts(choice.message);
  const response = {
    candidates: [{
      content: { role: "model", parts: parts.length ? parts : [{ text: "" }] },
      finishReason: mapFinish(choice.finish_reason),
      index: 0
    }]
  };
  if (body.model) response.modelVersion = body.model;
  const usage = openAIToGeminiUsage(body.usage);
  if (usage) response.usageMetadata = usage;
  return response;
}

register(FORMATS.OPENAI, FORMATS.GEMINI, null, openaiChunkToGemini);
