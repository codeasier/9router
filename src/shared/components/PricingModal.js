"use client";

import { useMemo, useState, useEffect } from "react";
import { getDefaultPricing, getPricingForModel } from "open-sse/providers/pricing.js";
import {
  PRICING_FIELDS,
  EMPTY_RATES,
  addPricingRow,
  customModelKey,
  isCatalogModel,
  isUserOwnedModel,
  normalizeRates,
  removePricingRow,
  sortPricingModels,
  sortPricingProviders,
  providerPricingLabel,
} from "@/shared/utils/pricingEditor.js";
import { getProviderByAlias } from "@/shared/constants/providers";

export default function PricingModal({ isOpen, onClose, onSave }) {
  const [pricingData, setPricingData] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("yours");
  const [addProvider, setAddProvider] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addError, setAddError] = useState("");
  const [pendingDeletes, setPendingDeletes] = useState([]);

  const catalog = useMemo(() => getDefaultPricing(), []);
  const customKeys = useMemo(() => {
    const keys = new Set();
    for (const custom of customModels) {
      if (custom?.providerAlias && custom?.id) keys.add(customModelKey(custom.providerAlias, custom.id));
    }
    return keys;
  }, [customModels]);
  const customNames = useMemo(() => {
    const names = new Map();
    for (const custom of customModels) {
      if (custom?.providerAlias && custom?.id) {
        names.set(customModelKey(custom.providerAlias, custom.id), custom.name || custom.id);
      }
    }
    return names;
  }, [customModels]);

  useEffect(() => {
    if (isOpen) {
      loadPricing();
    }
  }, [isOpen]);

  const loadPricing = async () => {
    setLoading(true);
    setAddError("");
    setPendingDeletes([]);
    try {
      const [pricingRes, customRes] = await Promise.all([
        fetch("/api/pricing"),
        fetch("/api/models/custom"),
      ]);
      if (pricingRes.ok) {
        const data = await pricingRes.json();
        setPricingData(data);
        const customList = customRes.ok ? ((await customRes.json()).models || []) : [];
        setCustomModels(Array.isArray(customList) ? customList : []);
        const keys = new Set();
        for (const custom of customList || []) {
          if (custom?.providerAlias && custom?.id) keys.add(customModelKey(custom.providerAlias, custom.id));
        }
        const hasYours = Object.entries(data || {}).some(([provider, models]) =>
          Object.keys(models || {}).some((model) => isUserOwnedModel(provider, model, catalog, keys))
        );
        setTab(hasYours ? "yours" : "catalog");
      } else {
        setPricingData(getDefaultPricing());
        setCustomModels([]);
        setTab("catalog");
      }
    } catch (error) {
      console.error("Failed to load pricing:", error);
      setPricingData(getDefaultPricing());
      setCustomModels([]);
    } finally {
      setLoading(false);
    }
  };

  const handlePricingChange = (provider, model, field, value) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;

    setPricingData((prev) => ({
      ...prev,
      [provider]: {
        ...(prev[provider] || {}),
        [model]: {
          ...EMPTY_RATES,
          ...(prev[provider]?.[model] || {}),
          [field]: numValue,
        },
      },
    }));
  };

  const handleAddModel = () => {
    const resolved = getPricingForModel(addProvider.trim(), addModel.trim());
    const result = addPricingRow(pricingData, addProvider, addModel, resolved);
    if (!result.added) {
      setAddError(result.reason === "exists" ? "That model is already in the list." : "Provider and model are required.");
      return;
    }
    setPricingData(result.data);
    setPendingDeletes((prev) => prev.filter((row) => !(row.provider === addProvider.trim() && row.model === addModel.trim())));
    setAddError("");
    setAddModel("");
    setTab("yours");
  };

  const handleRemoveModel = (provider, model) => {
    const isCustom = customKeys.has(customModelKey(provider, model));
    if (isCustom) {
      setPricingData((prev) => ({
        ...prev,
        [provider]: {
          ...(prev[provider] || {}),
          [model]: normalizeRates(getPricingForModel(provider, model)),
        },
      }));
    } else {
      setPricingData((prev) => removePricingRow(prev, provider, model));
    }
    setPendingDeletes((prev) => [...prev.filter((row) => !(row.provider === provider && row.model === model)), { provider, model }]);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pricingData)
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Failed to save pricing: ${error.error}`);
        return;
      }

      for (const row of pendingDeletes) {
        const params = new URLSearchParams({ provider: row.provider, model: row.model });
        await fetch(`/api/pricing?${params.toString()}`, { method: "DELETE" });
      }

      onSave?.();
      onClose();
    } catch (error) {
      console.error("Failed to save pricing:", error);
      alert("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm("Reset all pricing to defaults? This cannot be undone.")) return;

    try {
      const response = await fetch("/api/pricing", { method: "DELETE" });
      if (response.ok) {
        await loadPricing();
      }
    } catch (error) {
      console.error("Failed to reset pricing:", error);
      alert("Failed to reset pricing");
    }
  };

  const query = search.trim().toLowerCase();
  const visibleProviders = sortPricingProviders(Object.keys(pricingData), pricingData, catalog, customKeys)
    .map((provider) => {
      const models = sortPricingModels(provider, Object.keys(pricingData[provider] || {}), catalog, customKeys)
        .filter((model) => {
          const yours = isUserOwnedModel(provider, model, catalog, customKeys);
          if (tab === "yours" && !yours) return false;
          if (tab === "catalog" && yours) return false;
          if (!query) return true;
          const name = customNames.get(customModelKey(provider, model)) || "";
          return provider.toLowerCase().includes(query)
            || model.toLowerCase().includes(query)
            || name.toLowerCase().includes(query);
        });
      return { provider, models };
    })
    .filter((group) => group.models.length > 0);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col bg-surface border border-border-subtle rounded-[14px] shadow-[var(--shadow-elev)]">
        <div className="p-4 border-b border-border-subtle flex items-center justify-between bg-surface">
          <h2 className="text-xl font-semibold text-text-main">Pricing Configuration</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-main text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 bg-surface">
          {loading ? (
            <div className="text-center py-8 text-text-muted">Loading pricing data...</div>
          ) : (
            <div className="space-y-6">
              <div className="bg-surface-2 border border-border-subtle rounded-lg p-3 text-sm">
                <p className="font-medium mb-1 text-text-main">Pricing Rates Format</p>
                <p className="text-text-muted">
                  All rates are in <strong>dollars per million tokens</strong> ($/1M tokens).
                  Models you add on a provider page (for example Codex <code>gpt-6-astra</code>) show up under that provider&apos;s alias (<code>cx</code>). You can also add any provider/model below.
                </p>
              </div>

              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <label className="flex-1 text-sm">
                  <span className="block mb-1 text-text-muted">Provider alias</span>
                  <input
                    value={addProvider}
                    onChange={(e) => setAddProvider(e.target.value)}
                    placeholder="cx, cc, openai…"
                    className="w-full px-3 py-2 bg-surface text-text-main border border-border rounded focus:outline-none focus:border-primary"
                  />
                </label>
                <label className="flex-[2] text-sm">
                  <span className="block mb-1 text-text-muted">Model id</span>
                  <input
                    value={addModel}
                    onChange={(e) => setAddModel(e.target.value)}
                    placeholder="my-custom-model"
                    className="w-full px-3 py-2 bg-surface text-text-main border border-border rounded focus:outline-none focus:border-primary"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleAddModel}
                  className="px-4 py-2 text-sm bg-primary text-white rounded hover:bg-primary/90 transition-colors"
                >
                  Add model
                </button>
              </div>
              {addError ? <p className="text-sm text-red-500">{addError}</p> : null}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-1 rounded-lg border border-border bg-surface-2 p-1">
                  {[
                    { id: "yours", label: "Your models" },
                    { id: "catalog", label: "Catalog" },
                    { id: "all", label: "All" },
                  ].map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                        tab === item.id ? "bg-primary text-white" : "text-text-muted hover:text-text-main"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search provider or model"
                  className="w-full sm:w-72 px-3 py-2 bg-surface text-text-main border border-border rounded focus:outline-none focus:border-primary"
                />
              </div>

              {visibleProviders.map(({ provider, models }) => (
                <div key={provider} className="border border-border-subtle rounded-lg overflow-hidden bg-surface">
                  <div className="bg-surface-2 px-4 py-2 font-semibold text-sm text-text-main">
                    {providerPricingLabel(provider, getProviderByAlias)}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-surface-2 text-text-muted uppercase text-xs">
                        <tr>
                          <th className="px-3 py-2 text-left">Model</th>
                          <th className="px-3 py-2 text-right">Input</th>
                          <th className="px-3 py-2 text-right">Output</th>
                          <th className="px-3 py-2 text-right">Cached</th>
                          <th className="px-3 py-2 text-right">Reasoning</th>
                          <th className="px-3 py-2 text-right">Cache Creation</th>
                          <th className="px-3 py-2 text-right"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle">
                        {models.map((model) => {
                          const yours = isUserOwnedModel(provider, model, catalog, customKeys);
                          const displayName = customNames.get(customModelKey(provider, model)) || model;
                          return (
                            <tr key={model} className="hover:bg-surface-2/50">
                              <td className="px-3 py-2 font-medium text-text-main">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span>{displayName}</span>
                                  {displayName !== model ? (
                                    <span className="text-xs text-text-muted font-normal">{model}</span>
                                  ) : null}
                                  {yours ? (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold bg-primary/10 text-primary">
                                      {customKeys.has(customModelKey(provider, model)) ? "Custom" : "Added"}
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              {PRICING_FIELDS.map((field) => (
                                <td key={field} className="px-3 py-2">
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={pricingData[provider][model][field] ?? 0}
                                    onChange={(e) => handlePricingChange(provider, model, field, e.target.value)}
                                    className="w-20 px-2 py-1 text-right bg-surface text-text-main border border-border rounded focus:outline-none focus:border-primary"
                                  />
                                </td>
                              ))}
                              <td className="px-3 py-2 text-right">
                                {!isCatalogModel(catalog, provider, model) ? (
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveModel(provider, model)}
                                    className="text-xs text-text-muted hover:text-red-500"
                                  >
                                    Remove
                                  </button>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {visibleProviders.length === 0 && (
                <div className="text-center py-8 text-text-muted">
                  {tab === "yours"
                    ? "No custom or added models yet. Add a provider/model above, or switch to Catalog."
                    : "No pricing data available"}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border-subtle flex items-center justify-between gap-2 bg-surface">
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm text-red-500 hover:bg-red-500/10 rounded border border-red-500/20 transition-colors"
            disabled={saving}
          >
            Reset to Defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main border border-border rounded transition-colors"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
