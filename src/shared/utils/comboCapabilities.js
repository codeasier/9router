import { aggregateComboCapabilities } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { parseModel } from "open-sse/services/model.js";

export const COMBO_INPUT_CAPABILITIES = [
  { key: "vision", label: "Images" },
  { key: "pdf", label: "PDF / documents" },
  { key: "audioInput", label: "Audio" },
  { key: "videoInput", label: "Video" },
];

export const COMBO_FEATURE_CAPABILITIES = [
  { key: "tools", label: "Tool calling" },
  { key: "search", label: "Web search" },
  { key: "reasoning", label: "Reasoning" },
  { key: "thinkingCanDisable", label: "Can disable reasoning" },
  { key: "imageOutput", label: "Image output" },
  { key: "audioOutput", label: "Audio output" },
];

export const COMBO_THINKING_LEVELS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "thinking",
];

const BOOLEAN_FIELDS = new Set([
  ...COMBO_INPUT_CAPABILITIES, ...COMBO_FEATURE_CAPABILITIES,
].map(({ key }) => key));
const LIMIT_FIELDS = new Set(["contextWindow", "maxOutput"]);

// A sparse override: absent/null fields inherit member metadata. Replacing this
// object with {} restores automatic aggregation without altering combo members.
export function normalizeComboCapabilities(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capabilities must be an object or null");
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!BOOLEAN_FIELDS.has(key) && !LIMIT_FIELDS.has(key) && key !== "thinkingLevels") {
      throw new Error(`Unknown combo capability: ${key}`);
    }
    if (entry == null) continue;
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof entry !== "boolean") throw new Error(`${key} must be a boolean`);
      result[key] = entry;
    } else if (LIMIT_FIELDS.has(key)) {
      if (!Number.isSafeInteger(entry) || entry <= 0) {
        throw new Error(`${key} must be a positive integer (tokens)`);
      }
      result[key] = entry;
    } else {
      if (!Array.isArray(entry) || entry.some((level) => !COMBO_THINKING_LEVELS.includes(level))) {
        throw new Error(`thinkingLevels must contain only: ${COMBO_THINKING_LEVELS.join(", ")}`);
      }
      result[key] = [...new Set(entry)];
    }
  }
  if (result.contextWindow && result.maxOutput > result.contextWindow) {
    throw new Error("maxOutput must not exceed contextWindow");
  }
  return result;
}

// Browser and API use the same merge. Resolve nested combos here so their manual
// overrides are included before the parent aggregates limits and modalities.
export function resolveComboCapabilities(combo, combos = [], resolveCaps = null, ancestors = []) {
  if (!combo || ancestors.length > 6 || ancestors.includes(combo.name)) return null;
  const path = [...ancestors, combo.name];
  const resolveMember = (id) => {
    const nested = !id.includes("/") && combos.find((entry) => entry.name === id);
    return nested
      ? resolveComboCapabilities(nested, combos, resolveCaps, path)
      : resolveCaps?.(id);
  };
  const inherited = aggregateComboCapabilities(combo.models, null, resolveMember);
  const override = combo.capabilities || {};
  if (!inherited && Object.keys(override).length === 0) return null;

  const primary = combo.models?.[0];
  const nested = primary && !primary.includes("/") && combos.find((entry) => entry.name === primary);
  const parsed = parseModel(primary);
  const levels = nested
    ? resolveMember(primary)?.thinkingLevels
    : getThinkingLevels(parsed.provider, parsed.model);
  const caps = { ...inherited, ...(levels ? { thinkingLevels: levels } : {}), ...override };
  if (caps.reasoning === false) caps.thinkingLevels = [];
  else if (caps.thinkingCanDisable === false && caps.thinkingLevels) {
    caps.thinkingLevels = caps.thinkingLevels.filter((level) => level !== "none");
  }
  return caps;
}
