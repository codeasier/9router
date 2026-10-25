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
 * Nested structures keep their exact shape and are shared, except for the
 * generationConfig container: the shared thinking post-processor can rewrite
 * its fields, so detach that container without deep-copying client history.
 */
export function geminiNativePayload(body) {
  const payload = {};
  if (!body || typeof body !== "object") return payload;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (GATEWAY_ONLY_FIELDS.has(key)) continue;
    payload[key] = key === "generationConfig" && value && typeof value === "object"
      ? { ...value }
      : value;
  }
  return payload;
}

/**
 * Antigravity's executor reads `body.request.{contents,tools}` and builds the
 * `v1internal` envelope itself, so hand it `{ model, request: <payload> }`.
 *
 * All Antigravity models, including Claude, use this Google wire (`contents`).
 * Claude `messages` are only an internal bridge representation, not the upstream
 * protocol. The executor owns provider compatibility (IDs/names, schemas,
 * signatures, session/envelope fields); never rebuild native client contents.
 */
export function geminiToAntigravityRequest(model, body) {
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
