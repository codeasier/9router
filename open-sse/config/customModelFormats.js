import { FORMATS } from "../translator/formats.js";

// UI / issue aliases → translator wire formats. Keep this a leaf module so
// providerModels getters can consult the overlay without import cycles.
const PROTOCOL_ALIASES = {
  chat: FORMATS.OPENAI,
  responses: FORMATS.OPENAI_RESPONSES,
  resp: FORMATS.OPENAI_RESPONSES,
  messages: FORMATS.CLAUDE,
  "anthropic message": FORMATS.CLAUDE,
  "anthropic-message": FORMATS.CLAUDE,
  [FORMATS.OPENAI]: FORMATS.OPENAI,
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.OPENAI_RESPONSE]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
};

export const KNOWN_PROTOCOL_FORMATS = [
  FORMATS.OPENAI,
  FORMATS.CLAUDE,
  FORMATS.OPENAI_RESPONSES,
];

/** @type {Array<{ providerAlias: string, id: string, type?: string, supportedFormats?: string[]|null, targetFormat?: string|null }>} */
let overlay = [];

function baseModelId(modelId) {
  const match = typeof modelId === "string" ? modelId.match(/\([^()]+\)\s*$/) : null;
  return match ? modelId.slice(0, match.index).trim() : modelId;
}

export function normalizeProtocolFormat(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key || key === "auto") return null;
  return PROTOCOL_ALIASES[key] || null;
}

export function sanitizeSupportedFormats(value) {
  if (!Array.isArray(value)) return null;
  const clean = [];
  for (const entry of value) {
    const format = normalizeProtocolFormat(entry);
    if (format && KNOWN_PROTOCOL_FORMATS.includes(format) && !clean.includes(format)) {
      clean.push(format);
    }
  }
  return clean.length ? clean : null;
}

export function sanitizeTargetFormat(value, supportedFormats = null) {
  const format = normalizeProtocolFormat(value);
  if (!format) return null;
  if (supportedFormats && !supportedFormats.includes(format)) return null;
  return format;
}

export function setCustomModelFormatOverlay(models) {
  overlay = Array.isArray(models) ? models.filter((model) => model && typeof model === "object") : [];
}

export function getCustomModelFormatOverlay() {
  return overlay;
}

export function findCustomModelFormats(aliasOrId, modelId, extraAliases = []) {
  if (!aliasOrId || !modelId) return null;
  const keys = new Set([aliasOrId, ...extraAliases].filter(Boolean));
  const baseId = baseModelId(modelId);
  for (const model of overlay) {
    const type = model.kind || model.type || "llm";
    if (type !== "llm") continue;
    if (!keys.has(model.providerAlias) && !keys.has(model.provider)) continue;
    if (model.id !== modelId && model.id !== baseId) continue;
    const supportedFormats = sanitizeSupportedFormats(model.supportedFormats);
    const targetFormat = sanitizeTargetFormat(model.targetFormat, supportedFormats);
    if (!supportedFormats && !targetFormat) return { supportedFormats: null, targetFormat: null };
    return { supportedFormats, targetFormat };
  }
  return null;
}
