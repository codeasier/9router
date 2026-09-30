"use client";

import { useMemo, useState } from "react";
import { VOLCEAPI_WINDOWS } from "open-sse/config/volceapi.js";
import {
  buildVolceapiQuotaLimitsPayload,
  sanitizeVolceapiQuotaLimits,
} from "./utils";

function derivedInput(limits, key) {
  const value = Number(limits?.[key]);
  return Number.isFinite(value) && value > 0 ? String(value) : "";
}

/**
 * Edit the per-connection local credit caps (day/week/month) for volceapi.
 * Saves via PUT /api/providers/[id] with a complete quotaLimits object —
 * the endpoint shallow-merges providerSpecificData, so partial payloads
 * would silently drop the other windows.
 *
 * Inputs are derived from the limits prop; only user edits are kept in
 * state, so a refreshed limits prop re-seeds the fields without an effect.
 */
export default function VolceapiLimitsEditor({ connectionId, limits, onSaved }) {
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const inputs = useMemo(() => {
    const values = {};
    for (const key of VOLCEAPI_WINDOWS) {
      values[key] = key in edits ? edits[key] : derivedInput(limits, key);
    }
    return values;
  }, [edits, limits]);

  const sanitized = useMemo(() => sanitizeVolceapiQuotaLimits(inputs), [inputs]);
  const payload = useMemo(() => buildVolceapiQuotaLimitsPayload(inputs), [inputs]);

  function handleInput(key, value) {
    setSaved(false);
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!payload || saving || !connectionId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: { quotaLimits: payload },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSaved(true);
      // Re-derive from the refreshed limits prop once the parent patches it.
      setEdits({});
      onSaved?.(payload);
    } catch (err) {
      setError(err?.message || "Failed to save limits");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Local credit caps
        </h4>
        <button
          type="button"
          onClick={handleSave}
          disabled={!payload || saving || !connectionId}
          className="flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span
            className={`material-symbols-outlined text-[14px] ${saving ? "animate-spin" : ""}`}
            aria-hidden="true"
          >
            {saving ? "progress_activity" : "save"}
          </span>
          {saving ? "Saving…" : "Save caps"}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {VOLCEAPI_WINDOWS.map((key) => {
          const invalid = sanitized[key] == null;
          return (
            <label key={key} className="min-w-0">
              <span className="mb-1 block text-[11px] text-text-muted">{key}</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={inputs[key]}
                onChange={(e) => handleInput(key, e.target.value)}
                disabled={saving || !connectionId}
                aria-label={`Local credit cap (${key})`}
                aria-invalid={invalid}
                className={`w-full rounded-lg border bg-white px-2 py-1.5 text-sm tabular-nums text-text-primary outline-none transition-colors disabled:opacity-60 dark:bg-neutral-950 ${
                  invalid
                    ? "border-red-500/50 focus:border-red-500"
                    : "border-black/10 focus:border-primary/50 dark:border-white/10"
                }`}
              />
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
        Local caps for the remaining% display — not upstream quota, and never auto-disables the connection. Applies on the next quota refresh.
        {saved && <span className="ml-1 font-medium text-primary">Saved ✓</span>}
      </p>
      {error && (
        <p className="mt-1 text-[11px] text-red-600 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
