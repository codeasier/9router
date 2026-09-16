// Registry-driven per-model request overrides (body params + extra headers).
// Merge order in DefaultExecutor: stripUnsupportedParams → body set/drop → headers
// (after connection custom headers, before auth so Authorization cannot be clobbered).

import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { normalizeModelId } from "../providers/models/schema.js";
import { normalizeCustomHeaders } from "../utils/customHeaders.js";

function modelCandidates(model) {
  if (typeof model !== "string" || !model.trim()) return [];
  const clean = stripThinkingSuffix(model);
  const normalized = normalizeModelId(clean);
  return [...new Set([model, clean, normalized].filter(Boolean))];
}

function compileMatch(match) {
  if (match instanceof RegExp) return match;
  if (typeof match === "string" && match.trim()) {
    try {
      return new RegExp(match, "i");
    } catch {
      return null;
    }
  }
  return null;
}

export function modelMatchesOverride(rule, model) {
  if (!rule || typeof rule !== "object") return false;
  const candidates = modelCandidates(model);
  if (Array.isArray(rule.models) && rule.models.length) {
    const wanted = new Set(
      rule.models
        .filter((id) => typeof id === "string" && id.trim())
        .flatMap((id) => {
          const trimmed = id.trim();
          return [trimmed.toLowerCase(), normalizeModelId(trimmed).toLowerCase()];
        }),
    );
    if (wanted.size === 0) return false;
    return candidates.some((id) => wanted.has(id.toLowerCase()));
  }
  if (rule.match) {
    const re = compileMatch(rule.match);
    if (!re) return false;
    return candidates.some((id) => re.test(id));
  }
  return true;
}

export function collectMatchingOverrides(rules, model) {
  if (!Array.isArray(rules) || !rules.length) return [];
  return rules.filter((rule) => modelMatchesOverride(rule, model));
}

export function applyRequestBodyOverrides(body, rules, model) {
  if (!body || typeof body !== "object") return body;
  for (const rule of collectMatchingOverrides(rules, model)) {
    const drop = [...(rule.drop || []), ...(rule.omit || [])];
    for (const key of drop) {
      if (typeof key === "string" && body[key] !== undefined) delete body[key];
    }
    const set = (rule.set && typeof rule.set === "object" && !Array.isArray(rule.set))
      ? rule.set
      : (rule.body && typeof rule.body === "object" && !Array.isArray(rule.body) ? rule.body : null);
    if (!set) continue;
    for (const [key, value] of Object.entries(set)) {
      if (value !== undefined) body[key] = value;
    }
  }
  return body;
}

export function resolveRequestHeaderOverrides(rules, model) {
  const headers = {};
  for (const rule of collectMatchingOverrides(rules, model)) {
    if (!rule.headers || typeof rule.headers !== "object" || Array.isArray(rule.headers)) continue;
    for (const [name, value] of Object.entries(rule.headers)) {
      if (typeof name !== "string" || typeof value !== "string") continue;
      headers[name] = value;
    }
  }
  try {
    return normalizeCustomHeaders(headers);
  } catch {
    return {};
  }
}
