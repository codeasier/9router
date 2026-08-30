"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { translate } from "@/i18n/runtime";

const PROVIDER_OPTIONS = Object.values(AI_PROVIDERS)
  .filter((p) => !p.hidden)
  .map((p) => ({ id: p.id, name: p.name || p.id }))
  .sort((a, b) => a.name.localeCompare(b.name));

export default function BulkPolicyEditorModal({ isOpen, selectedIds, keys, onClose, onSaved }) {
  const selectedCount = selectedIds?.size || 0;
  const selectedKeys = keys?.filter((k) => selectedIds?.has(k.id)) || [];

  const [budgets, setBudgets] = useState([]);
  const [maxConcurrent, setMaxConcurrent] = useState("");
  const [breakerMode, setBreakerMode] = useState("fixed");
  const [breakerMinutes, setBreakerMinutes] = useState("5");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Reset form when opening
  useEffect(() => {
    if (!isOpen) return;
    // Initialize from first selected key if all share same policy, otherwise empty
    // For simplicity start empty; user defines the policy to apply to all.
    setBudgets([]);
    setMaxConcurrent("");
    setBreakerMode("fixed");
    setBreakerMinutes("5");
    setError(null);
  }, [isOpen, selectedCount]);

  const updateBudget = (i, field, value) => {
    setBudgets((prev) => prev.map((b, idx) => (idx === i ? { ...b, [field]: value } : b)));
  };
  const addBudget = () => setBudgets((prev) => [...prev, { provider: "*", limitUsd: "", period: "day" }]);
  const removeBudget = (i) => setBudgets((prev) => prev.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    setError(null);
    const cleanBudgets = budgets
      .map((b) => ({
        provider: b.provider.trim() || "*",
        limitUsd: Number(b.limitUsd),
        period: b.period,
      }))
      .filter((b) => Number.isFinite(b.limitUsd) && b.limitUsd > 0);

    const mc = Number(maxConcurrent);
    const hasMc = maxConcurrent.trim() !== "" && Number.isFinite(mc) && mc >= 1;

    const policy = {};
    if (cleanBudgets.length > 0) policy.budgets = cleanBudgets;
    if (hasMc) policy.maxConcurrent = Math.floor(mc);
    if (cleanBudgets.length > 0 || hasMc) {
      policy.breaker = {
        mode: breakerMode === "period" ? "period" : "fixed",
        durationMinutes: Math.max(0.5, Number(breakerMinutes) || 5),
      };
    }
    const payload = Object.keys(policy).length > 0 ? policy : null;

    if (!selectedCount) {
      setError("No keys selected");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/keys/bulk/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds), policy: payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to apply policy");
        return;
      }
      // data.results contains per-key updated records
      onSaved?.(data.results);
      onClose();
    } catch (e) {
      setError(e.message || "Failed to apply policy");
    } finally {
      setSaving(false);
    }
  };

  const handleClearPolicy = async () => {
    if (!selectedCount || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/keys/bulk/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds), policy: null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to clear policy");
        return;
      }
      onSaved?.(data.results);
      onClose();
    } catch (e) {
      setError(e.message || "Failed to clear policy");
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    "px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary";

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} size="xl" title={`${translate("Bulk Policy")} — ${selectedCount} ${translate("keys selected")}`} onClose={onClose}>
      <div className="flex flex-col gap-5 max-h-[70vh] overflow-y-auto">
        {selectedCount > 0 && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex flex-col gap-1">
            <p className="text-sm font-medium flex items-center gap-1.5 text-primary">
              <span className="material-symbols-outlined text-[16px]">group</span>
              {translate("Applying to")} {selectedCount} {translate("keys")}:
              <span className="font-normal text-text-muted text-xs ml-1">{selectedKeys.map((k) => k.name).join(", ")}</span>
            </p>
            <p className="text-xs text-text-muted">{translate("This will overwrite the existing policy for all selected keys.")}</p>
          </div>
        )}

        {/* Budgets */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Provider Budgets (USD / period, UTC)</p>
            <Button size="sm" icon="add" onClick={addBudget}>Add</Button>
          </div>
          {budgets.length === 0 && (
            <p className="text-xs text-text-muted">No budgets — unlimited spend. Example: provider &quot;codex&quot;, $5 per day. Leave empty and save to clear budgets (keep concurrency/breaker if set).</p>
          )}
          {budgets.map((b, i) => (
            <div key={i} className="grid grid-cols-[minmax(180px,1fr)_110px_130px_36px] gap-2 items-center mb-2">
              {(() => {
                const known = b.provider === "*" || PROVIDER_OPTIONS.some((p) => p.id === b.provider);
                return (
                  <div className="flex items-center gap-2 min-w-0">
                    <select
                      value={known ? (b.provider || "*") : "custom"}
                      onChange={(e) => updateBudget(i, "provider", e.target.value === "custom" ? "" : e.target.value)}
                      className={selectClass + " flex-1 min-w-0"}
                    >
                      <option value="*">{translate("All providers")} (*)</option>
                      {PROVIDER_OPTIONS.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                      ))}
                      <option value="custom">{translate("Custom")}…</option>
                    </select>
                    {!known && (
                      <Input
                        value={b.provider}
                        onChange={(e) => updateBudget(i, "provider", e.target.value)}
                        placeholder={translate("provider id")}
                        className="flex-1 min-w-[120px]"
                      />
                    )}
                  </div>
                );
              })()}
              <Input
                value={b.limitUsd}
                onChange={(e) => updateBudget(i, "limitUsd", e.target.value)}
                placeholder="$"
                type="number"
                min="0"
                step="0.5"
                className="w-full"
              />
              <select
                value={b.period}
                onChange={(e) => updateBudget(i, "period", e.target.value)}
                className={selectClass + " w-full"}
              >
                <option value="day">{translate("daily")}</option>
                <option value="week">{translate("weekly")}</option>
                <option value="month">{translate("monthly")}</option>
              </select>
              <button
                onClick={() => removeBudget(i)}
                className="p-2 hover:bg-red-500/10 rounded text-red-500 justify-self-center"
                title={translate("Remove budget")}
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          ))}
        </div>

        {/* Breaker */}
        <div>
          <p className="text-sm font-medium mb-1">Circuit Breaker Recovery</p>
          <p className="text-xs text-text-muted mb-2">Applied when a budget is exceeded. Only saved if budgets or concurrency are set.</p>
          <div className="flex flex-wrap items-center gap-3">
            <select value={breakerMode} onChange={(e) => setBreakerMode(e.target.value)} className={selectClass + " min-w-[280px] flex-1 max-w-[360px]"}>
              <option value="fixed">{translate("Fixed duration (re-check after cooldown)")}</option>
              <option value="period">{translate("Until period ends (day/week/month rollover)")}</option>
            </select>
            {breakerMode === "fixed" && (
              <div className="flex items-center gap-2 shrink-0">
                <Input
                  value={breakerMinutes}
                  onChange={(e) => setBreakerMinutes(e.target.value)}
                  type="number"
                  min="0.5"
                  step="0.5"
                  className="w-24"
                />
                <span className="text-sm text-text-muted">{translate("min")}</span>
              </div>
            )}
          </div>
        </div>

        {/* Concurrency */}
        <div className="pt-3 border-t border-border/50">
          <p className="text-sm font-medium mb-1">Max Concurrent Requests</p>
          <p className="text-xs text-text-muted mb-2">Fast-fail with 429 when this key has more requests in flight.</p>
          <Input
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(e.target.value)}
            placeholder={translate("unlimited")}
            type="number"
            min="1"
            className="w-32"
          />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex gap-2 justify-between items-center pt-2 border-t border-border/30">
          <Button variant="ghost" onClick={handleClearPolicy} disabled={saving} icon="block">
            {translate("Clear policy (unlimited)")}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? translate("Saving…") : translate("Apply to selected")}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

BulkPolicyEditorModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  selectedIds: PropTypes.object, // Set
  keys: PropTypes.array,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
};
