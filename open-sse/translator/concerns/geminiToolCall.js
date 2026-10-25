import { generateToolCallId } from "./toolCall.js";

function explicitToolId(id) {
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Claude backends require request-wide unique, Anthropic-compatible tool IDs.
// Keep the Google contents/parts wire intact: only copy/update the ID-bearing
// objects, retaining signatures, media, response payloads and all extra fields.
// Callers must look up cached signatures BEFORE this pass and sanitize names AFTER
// it, since reconciliation needs the client's original IDs AND original names.
export function normalizeGeminiToolCallIds(contents) {
  if (!Array.isArray(contents)) return contents;

  const reservedIds = new Set();
  for (const content of contents) {
    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      for (const id of [part.functionCall?.id, part.functionResponse?.id]) {
        const rawId = explicitToolId(id);
        if (rawId) reservedIds.add(rawId);
      }
    }
  }

  const usedIds = new Set();
  const pending = [];
  const allocateId = (rawId, msgIndex, tcIndex, name) => {
    let id = rawId?.replace(/[^a-zA-Z0-9_-]/g, "");
    // Reserve the whole history so generation/sanitization cannot take an ID
    // belonging to a later explicit call (or a result-only explicit ID).
    if (!id || usedIds.has(id) || (id !== rawId && reservedIds.has(id))) {
      const base = generateToolCallId(msgIndex, tcIndex, name);
      id = base;
      let suffix = 1;
      while (usedIds.has(id) || reservedIds.has(id)) id = `${base}_${suffix++}`;
    }
    usedIds.add(id);
    return id;
  };

  const resolveResultId = (response, msgIndex, partIndex) => {
    const rawId = explicitToolId(response.id);
    let index = rawId
      ? pending.findIndex(call => call.rawId === rawId && call.name === response.name)
      : -1;
    if (index < 0) {
      // Legacy ID-less same-name calls cannot express out-of-order results: FIFO
      // is the only available pairing. A result-only ID can answer an ID-less
      // call, but must never consume a call with a different explicit ID.
      index = pending.findIndex(call => call.name === response.name && (!rawId || !call.rawId));
    }
    if (index >= 0) return pending.splice(index, 1)[0].id;

    // Keep orphan results rather than inventing a pairing or rejecting history.
    if (rawId && /^[a-zA-Z0-9_-]+$/.test(rawId)) return rawId;
    return allocateId(rawId, msgIndex, partIndex, response.name);
  };

  return contents.map((content, msgIndex) => {
    if (!Array.isArray(content.parts)) return content;
    let tcIndex = 0;
    const parts = content.parts.map((part, partIndex) => {
      let normalized = part;
      if (part.functionCall) {
        const call = part.functionCall;
        const rawId = explicitToolId(call.id);
        const id = allocateId(rawId, msgIndex, tcIndex++, call.name);
        pending.push({ rawId, id, name: call.name });
        normalized = { ...normalized, functionCall: { ...call, id } };
      }
      if (part.functionResponse) {
        const response = part.functionResponse;
        const id = resolveResultId(response, msgIndex, partIndex);
        normalized = { ...normalized, functionResponse: { ...response, id } };
      }
      return normalized;
    });
    return { ...content, parts };
  });
}
