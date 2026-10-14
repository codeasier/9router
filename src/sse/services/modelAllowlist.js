// Chat model allowlist, shared with GET /v1/models.
//
// When settings.allowComboModelsOnly is on, a chat request may only name a model
// that GET /v1/models already publishes — a configured LLM combo name. Both paths
// read the kind helpers from here so the published list and the request gate
// cannot drift apart.
import { getCombos } from "@/lib/localDb";

// LLM kind sentinel — combos/models with no explicit kind default to LLM
export const LLM_KIND = "llm";

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
export function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// Model ids published for the given kinds: configured combo names, deduped.
export function collectComboModelIds(combos, kindFilter = [LLM_KIND]) {
  const ids = new Set();
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    if (combo?.name) ids.add(combo.name);
  }
  return [...ids];
}

// Allowed chat model ids. Returns null when combos cannot be read — callers must
// fail open rather than reject every model because the database is unavailable.
export async function getAllowedComboModelIds() {
  try {
    return collectComboModelIds(await getCombos());
  } catch {
    return null;
  }
}
