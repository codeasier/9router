// Gemini → Gemini-family upstreams, natively.
//
// A Gemini client (Google GenAI SDK, Gemini CLI, anything pointed at
// /v1beta/models/{model}:generateContent) already sends a GenerateContentRequest.
// Antigravity (Cloud Code `v1internal`) and Gemini CLI (Code Assist) carry that
// exact payload — the only difference is an outer envelope plus a few upstream
// quirks the executors already handle (schema cleaning, tool-name sanitising,
// thoughtSignature backfill, session ids).
//
// Pivoting through OpenAI here (source → openai → target) is what silently drops
// `tools`, `inlineData` and structured-output config, so these pairs are direct:
// the payload is copied, never rebuilt.
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { geminiToOpenAIRequest } from "./gemini-to-openai.js";
import { openaiToAntigravityRequest } from "./openai-to-gemini.js";

// 9router routing/serialisation fields. They are not part of
// GenerateContentRequest and Google rejects unknown top-level names.
const GATEWAY_ONLY_FIELDS = new Set([
  "model",
  "stream",
  "stream_options",
  "_compact",
  "proxies",
  "provider",
  "connectionId"
]);

/**
 * Copy the client's GenerateContentRequest without gateway-only fields.
 * Everything else (contents, tools, toolConfig, systemInstruction,
 * generationConfig, safetySettings, cachedContent, labels, …) is preserved by
 * reference so nested structures keep their exact shape.
 */
export function geminiNativePayload(body) {
  const payload = {};
  if (!body || typeof body !== "object") return payload;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (GATEWAY_ONLY_FIELDS.has(key)) continue;
    payload[key] = value;
  }
  return payload;
}

/**
 * Antigravity's executor reads `body.request.{contents,tools}` and builds the
 * `v1internal` envelope itself, so hand it `{ model, request: <payload> }`.
 *
 * Claude models on Antigravity speak the Claude wire (`messages`), not
 * `contents`; those fall back to the bridge (Gemini → OpenAI → Claude) because
 * the native payload would be rejected upstream.
 */
export function geminiToAntigravityRequest(model, body, stream, credentials = null) {
  if (String(model).toLowerCase().includes("claude")) {
    return openaiToAntigravityRequest(model, geminiToOpenAIRequest(model, body, stream), stream, credentials);
  }
  return { model, request: geminiNativePayload(body) };
}

/**
 * Gemini CLI's executor wraps `{ project, model, request }` whenever the body
 * has no `request` key, so the bare payload is the right input.
 */
export function geminiToGeminiCliRequest(_model, body) {
  return geminiNativePayload(body);
}

/** Vertex takes a bare GenerateContentRequest with the model in the URL. */
export function geminiToVertexRequest(_model, body) {
  return geminiNativePayload(body);
}

register(FORMATS.GEMINI, FORMATS.ANTIGRAVITY, geminiToAntigravityRequest, null);
register(FORMATS.GEMINI, FORMATS.GEMINI_CLI, geminiToGeminiCliRequest, null);
register(FORMATS.GEMINI, FORMATS.VERTEX, geminiToVertexRequest, null);
