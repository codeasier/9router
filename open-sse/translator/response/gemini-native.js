// Gemini-family upstreams → Gemini client, natively.
//
// Antigravity (`v1internal`), Gemini CLI (Code Assist) and Vertex all answer with
// a GenerateContentResponse; the private endpoints wrap it as `{ response: … }`
// and add transport metadata (traceId, metadata). A Gemini client must receive
// the inner object only — no field rewriting, no pivot through OpenAI.
//
// Registered as direct `target:source` response pairs so translateResponse()
// takes them instead of the OpenAI bridge.
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

/** Unwrap the private-API envelope; tolerate already-bare chunks. */
export function unwrapGeminiEnvelope(chunk) {
  if (chunk === null || chunk === undefined) return null;
  const inner = chunk.response ?? chunk;
  if (!inner || typeof inner !== "object") return null;
  return inner;
}

function passthroughGemini(chunk) {
  return unwrapGeminiEnvelope(chunk);
}

register(FORMATS.ANTIGRAVITY, FORMATS.GEMINI, null, passthroughGemini);
register(FORMATS.GEMINI_CLI, FORMATS.GEMINI, null, passthroughGemini);
register(FORMATS.VERTEX, FORMATS.GEMINI, null, passthroughGemini);
