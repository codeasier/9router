"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { translate } from "@/i18n/runtime";

const PERIOD_LABELS = { day: "daily", week: "weekly", month: "monthly" };

const PROVIDER_OPTIONS = Object.values(AI_PROVIDERS)
  .filter((p) => !p.hidden)
  .map((p) => ({ id: p.id, name: p.name || p.id }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Per-key policy editor: provider budgets (period + USD limit), concurrency
 * cap, and breaker recovery strategy. Saves via PUT /api/keys/[id] { policy }.
 *
 * policy shape: { budgets: [{provider, limitUsd, period}], maxConcurrent, breaker: {mode, durationMinutes} }
 */
export default function PolicyEditorModal({ isOpen, apiKeyRecord, onClose, onSaved, onReset }) {
  const [budgets, setBudgets] = useState(() => initBudgets(apiKeyRecord?.policy));
  const [maxConcurrent, setMaxConcurrent] = useState(apiKeyRecord?.policy?.maxConcurrent?.toString() || "");
  const [breakerMode, setBreakerMode] = useState(apiKeyRecord?.policy?.breaker?.mode || "fixed");
  const [breakerMinutes, setBreakerMinutes] = useState(
    apiKeyRecord?.policy?.breaker?.durationMinutes?.toString() || "5"
  );
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  // Live status polling: in-flight count, budget spend, open breakers.
  const fetchStatus = useCallback(async () => {
    if (!apiKeyRecord?.id) return;
    try {
      const res = await fetch(`/api/keys/${apiKeyRecord.id}/status`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data.status || null);
    } catch { /* transient poll errors */ }
  }, [apiKeyRecord?.id]);

  useEffect(() => {
    if (!isOpen) { setStatus(null); return; }
    fetchStatus();
    const timer = setInterval(() => { if (!document.hidden) fetchStatus(); }, 5000);
    return () => clearInterval(timer);
  }, [isOpen, fetchStatus]);

  const handleReset = async () => {
    if (!apiKeyRecord?.id || resetting) return;
    setResetting(true);
    setError(null);
    try {
      const res = await fetch(`/api/keys/${apiKeyRecord.id}/reset`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to reset");
        return;
      }
      setStatus(data.status || null);
      onReset?.(apiKeyRecord.id, data.status);
    } catch (e) {
      setError(e.message || "Failed to reset");
    } finally {
      setResetting(false);
    }
  };

  if (!apiKeyRecord) return null;

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

    setSaving(true);
    try {
      const res = await fetch(`/api/keys/${apiKeyRecord.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save policy");
        return;
      }
      onSaved?.(data.key);
      onClose();
    } catch (e) {
      setError(e.message || "Failed to save policy");
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    "px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <Modal isOpen={isOpen} size="xl" title={`${translate("Policy")} — ${apiKeyRecord.name || "API Key"}`} onClose={onClose}>
      <div className="flex flex-col gap-5 max-h-[70vh] overflow-y-auto">
        {/* Live status */}
        {status && (
          <div className="rounded-lg border border-border bg-surface-2/50 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-primary">monitoring</span>
                Live Status
              </p>
              <span className="text-[10px] text-text-muted">auto-refresh 5s</span>
            </div>
            {/* Concurrency */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-muted w-24 shrink-0">In-flight</span>
              {status.maxConcurrent ? (
                <span className={status.inflight >= status.maxConcurrent ? "text-red-500 font-mono" : "text-text-main font-mono"}>
                  {status.inflight} / {status.maxConcurrent}
                </span>
              ) : (
                <span className="text-text-main font-mono">{status.inflight}</span>
              )}
              {!status.maxConcurrent && <span className="text-xs text-text-muted">(no limit)</span>}
            </div>
            {/* Usage (all providers) */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-muted w-24 shrink-0">Spend (UTC)</span>
              <span className="font-mono text-xs text-text-main">
                {translate("today")} ${fmtUsd(status.usage?.day)} · {translate("week")} ${fmtUsd(status.usage?.week)} · {translate("month")} ${fmtUsd(status.usage?.month)}
              </span>
            </div>
            {/* Budget windows */}
            {status.budgets?.length > 0 && status.budgets.map((b, i) => {
              const pct = Math.min(100, (b.spentUsd / b.limitUsd) * 100);
              const over = b.spentUsd >= b.limitUsd;
              return (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono">
                      {b.provider === "*" ? translate("all providers") : b.provider} / {translate(PERIOD_LABELS[b.period] || b.period)}
                    </span>
                    <span className={`font-mono ${over ? "text-red-500" : pct >= 80 ? "text-amber-500" : "text-text-muted"}`}>
                      ${fmtUsd(b.spentUsd)} / ${fmtUsd(b.limitUsd)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${over ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-primary"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {/* Open breakers */}
            {(status.breaker || status.providerBreakers?.length > 0) && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1 text-xs text-red-500">
                  {status.breaker && (
                    <p className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[14px]">block</span>
                      {translate("Key breaker open")} — {status.breaker.reason} ({translate("until")} {new Date(status.breaker.untilMs).toLocaleTimeString()})
                    </p>
                  )}
                  {status.providerBreakers?.map((pb, i) => (
                    <p key={i} className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[14px]">block</span>
                      {pb.provider} {translate("breaker open")} — {pb.reason} ({translate("until")} {new Date(pb.untilMs).toLocaleTimeString()})
                    </p>
                  ))}
                </div>
                <button
                  onClick={handleReset}
                  disabled={resetting}
                  className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-800 bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-medium hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                >
                  <span className={`material-symbols-outlined text-[16px] ${resetting ? "animate-spin" : ""}`}>{resetting ? "progress_activity" : "restart_alt"}</span>
                  {resetting ? translate("Resetting…") : translate("Reset breaker")}
                </button>
              </div>
            )}
            {/* Manual reset hint when breaker not open but policy exists */}
            {status?.hasPolicy && !status.breaker && (!status.providerBreakers || status.providerBreakers.length === 0) && (
              <div className="flex justify-end">
                <button
                  onClick={handleReset}
                  disabled={resetting}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
                  title={translate("Clear breaker cooldown and refresh spend cache")}
                >
                  <span className={`material-symbols-outlined text-[14px] ${resetting ? "animate-spin" : ""}`}>{resetting ? "progress_activity" : "restart_alt"}</span>
                  {translate("Reset quota cache")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Budgets */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Provider Budgets (USD / period, UTC)</p>
            <Button size="sm" icon="add" onClick={addBudget}>Add</Button>
          </div>
          {budgets.length === 0 && (
            <p className="text-xs text-text-muted">No budgets — unlimited spend. Example: provider "codex", $5 per day.</p>
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

        {/* Breaker — directly follows Budgets (both are budget policy) */}
        <div>
          <p className="text-sm font-medium mb-1">Circuit Breaker Recovery</p>
          <p className="text-xs text-text-muted mb-2">Applied when a budget is exceeded.</p>
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

        {/* Concurrency — independent from budget/breaker, placed after */}
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

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? translate("Saving…") : translate("Save Policy")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function initBudgets(policy) {
  if (!policy?.budgets?.length) return [];
  return policy.budgets.map((b) => ({
    provider: b.provider || "*",
    limitUsd: String(b.limitUsd ?? ""),
    period: b.period || "day",
  }));
}

function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "0";
  return v >= 100 ? v.toFixed(0) : v.toFixed(2);
}

PolicyEditorModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  apiKeyRecord: PropTypes.object,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
  onReset: PropTypes.func,
};
