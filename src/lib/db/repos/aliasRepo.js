import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

function withProtocolMeta(record, { supportedFormats, targetFormat } = {}) {
  const next = { ...record };
  if (supportedFormats !== undefined) {
    if (supportedFormats) next.supportedFormats = supportedFormats;
    else delete next.supportedFormats;
  }
  if (targetFormat !== undefined) {
    if (targetFormat) next.targetFormat = targetFormat;
    else delete next.targetFormat;
  }
  return next;
}

async function refreshCustomModelFormatOverlay() {
  try {
    const { setCustomModelFormatOverlay } = await import("open-sse/config/customModelFormats.js");
    setCustomModelFormatOverlay(await getCustomModels());
  } catch { /* overlay is best-effort for routing */ }
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/protocol without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, supportedFormats, targetFormat } = {}) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  const protocolPatch = {};
  if (supportedFormats !== undefined) protocolPatch.supportedFormats = supportedFormats;
  if (targetFormat !== undefined) protocolPatch.targetFormat = targetFormat;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = withProtocolMeta(
        { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}) },
        protocolPatch,
      );
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson(withProtocolMeta(
      { providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}) },
      protocolPatch,
    ));
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  try {
    const { invalidatePricingCache } = await import("./pricingRepo.js");
    invalidatePricingCache();
  } catch { /* pricing cache is optional */ }
  await refreshCustomModelFormatOverlay();
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
  try {
    const { invalidatePricingCache } = await import("./pricingRepo.js");
    invalidatePricingCache();
  } catch { /* pricing cache is optional */ }
  await refreshCustomModelFormatOverlay();
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
