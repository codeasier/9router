export const PRICING_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];

export const EMPTY_RATES = {
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  cache_creation: 0,
};

export function pricingRowKey(provider, model) {
  return `${provider}/${model}`;
}

export function normalizeRates(pricing) {
  const out = { ...EMPTY_RATES };
  if (!pricing || typeof pricing !== "object") return out;
  for (const field of PRICING_FIELDS) {
    const n = Number(pricing[field]);
    if (Number.isFinite(n) && n >= 0) out[field] = n;
  }
  return out;
}

export function catalogModelSet(catalog) {
  const keys = new Set();
  for (const [provider, models] of Object.entries(catalog || {})) {
    for (const model of Object.keys(models || {})) {
      keys.add(pricingRowKey(provider, model));
    }
  }
  return keys;
}

export function isCatalogModel(catalog, provider, model) {
  return Boolean(catalog?.[provider]?.[model]);
}

export function customModelKey(providerAlias, id) {
  return `${providerAlias}|${id}`;
}

export function mergeCustomModelsIntoPricing(merged, customModels, resolveConst) {
  const next = merged && typeof merged === "object" ? merged : {};
  if (!Array.isArray(customModels)) return next;

  for (const custom of customModels) {
    const provider = typeof custom?.providerAlias === "string" ? custom.providerAlias.trim() : "";
    const model = typeof custom?.id === "string" ? custom.id.trim() : "";
    if (!provider || !model) continue;
    if (!next[provider]) next[provider] = {};
    if (next[provider][model]) continue;
    const resolved = typeof resolveConst === "function" ? resolveConst(provider, model) : null;
    next[provider][model] = normalizeRates(resolved);
  }
  return next;
}

export function addPricingRow(pricingData, provider, model, rates) {
  const p = typeof provider === "string" ? provider.trim() : "";
  const m = typeof model === "string" ? model.trim() : "";
  if (!p || !m) return { data: pricingData, added: false, reason: "empty" };
  if (pricingData?.[p]?.[m]) return { data: pricingData, added: false, reason: "exists" };
  return {
    data: {
      ...(pricingData || {}),
      [p]: {
        ...(pricingData?.[p] || {}),
        [m]: normalizeRates(rates),
      },
    },
    added: true,
  };
}

export function removePricingRow(pricingData, provider, model) {
  if (!pricingData?.[provider]) return pricingData || {};
  const models = { ...pricingData[provider] };
  delete models[model];
  const next = { ...pricingData };
  if (Object.keys(models).length === 0) delete next[provider];
  else next[provider] = models;
  return next;
}

export function isUserOwnedModel(provider, model, catalog, customKeys) {
  if (customKeys instanceof Set && customKeys.has(customModelKey(provider, model))) return true;
  return !isCatalogModel(catalog, provider, model);
}

export function sortPricingProviders(providers, pricingData, catalog, customKeys) {
  return [...providers].sort((a, b) => {
    const aYours = Object.keys(pricingData?.[a] || {}).some((model) => isUserOwnedModel(a, model, catalog, customKeys));
    const bYours = Object.keys(pricingData?.[b] || {}).some((model) => isUserOwnedModel(b, model, catalog, customKeys));
    if (aYours !== bYours) return aYours ? -1 : 1;
    return a.localeCompare(b);
  });
}

export function sortPricingModels(provider, models, catalog, customKeys) {
  return [...models].sort((a, b) => {
    const aYours = isUserOwnedModel(provider, a, catalog, customKeys);
    const bYours = isUserOwnedModel(provider, b, catalog, customKeys);
    if (aYours !== bYours) return aYours ? -1 : 1;
    return a.localeCompare(b);
  });
}

export function providerPricingLabel(provider, resolveProvider) {
  const info = typeof resolveProvider === "function" ? resolveProvider(provider) : null;
  const alias = info?.alias || info?.id || provider;
  const name = info?.name;
  if (name && alias && String(name).toLowerCase() !== String(alias).toLowerCase()) {
    return `${name} (${alias})`;
  }
  return String(alias || provider || "").toUpperCase();
}

export function lookupUserPricing(userPricing, provider, model, altKeys = []) {
  if (!model || !userPricing || typeof userPricing !== "object") return null;
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  for (const key of altKeys) {
    if (key && userPricing[key]?.[model]) return userPricing[key][model];
  }
  return null;
}
