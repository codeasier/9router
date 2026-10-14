"use client";

import { useState } from "react";
import { Button, Input, Modal, Select } from "@/shared/components";
import {
  COMBO_INPUT_CAPABILITIES,
  COMBO_FEATURE_CAPABILITIES,
  COMBO_THINKING_LEVELS,
  normalizeComboCapabilities,
  resolveComboCapabilities,
} from "@/shared/utils/comboCapabilities.js";

export default function ComboCapabilitiesModal({ combo, combos, getCaps, onClose, onSave }) {
  const [draft, setDraft] = useState(() => ({ ...combo.capabilities }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inherited = resolveComboCapabilities({ ...combo, capabilities: {} }, combos, getCaps);
  const patch = (key, value) => setDraft((prev) => {
    const next = { ...prev };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  });
  const close = () => { if (!saving) onClose(); };

  const save = async () => {
    if (saving) return;
    setError("");
    try {
      const values = { ...draft };
      for (const key of ["contextWindow", "maxOutput"]) {
        if (values[key] === "") delete values[key];
        else if (values[key] !== undefined) values[key] = Number(values[key]);
      }
      const capabilities = normalizeComboCapabilities(values);
      setSaving(true);
      await onSave(capabilities);
      onClose();
    } catch (err) {
      setError(err.message || "Failed to save model properties");
    } finally {
      setSaving(false);
    }
  };

  const capabilitySelect = ({ key, label }) => (
    <Select
      key={key}
      label={label}
      aria-label={label}
      value={draft[key] === undefined ? "auto" : String(draft[key])}
      onChange={(e) => patch(key, e.target.value === "auto" ? undefined : e.target.value === "true")}
      options={[
        { value: "auto", label: `Auto (${inherited?.[key] ? "Yes" : "No"})` },
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ]}
      disabled={saving}
    />
  );

  return (
    <Modal
      isOpen
      onClose={close}
      title="Combo Model Properties"
      size="xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" disabled={saving} onClick={() => { setDraft({}); setError(""); }}>
            Restore Auto
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={saving} onClick={close}>Cancel</Button>
            <Button loading={saving} disabled={saving} onClick={save}>Save</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div>
          <code className="font-mono text-sm font-medium break-all">{combo.name}</code>
          <p className="mt-1 text-xs text-text-muted">
            Properties published in /v1/models. Auto follows the combo&apos;s member models.
          </p>
        </div>

        <section className="flex flex-col gap-3" aria-label="Token limits">
          <h3 className="text-sm font-semibold">Token limits</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              ["contextWindow", "Context window"],
              ["maxOutput", "Maximum output"],
            ].map(([key, label]) => (
              <Input
                key={key}
                label={label}
                aria-label={label}
                type="number"
                min="1"
                step="1"
                value={draft[key] ?? ""}
                onChange={(e) => patch(key, e.target.value)}
                placeholder={inherited?.[key] ? String(inherited[key]) : "Auto"}
                hint={`Auto: ${inherited?.[key]?.toLocaleString() || "unknown"} tokens. Leave empty to inherit.`}
                disabled={saving}
              />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3" aria-label="Input types">
          <div>
            <h3 className="text-sm font-semibold">Input types</h3>
            <p className="mt-1 text-xs text-text-muted">Text input is always supported.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {COMBO_INPUT_CAPABILITIES.map(capabilitySelect)}
          </div>
        </section>

        <section className="flex flex-col gap-3" aria-label="Features and reasoning">
          <h3 className="text-sm font-semibold">Features and reasoning</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {COMBO_FEATURE_CAPABILITIES.map(capabilitySelect)}
          </div>
          <Select
            label="Supported thinking levels"
            aria-label="Supported thinking levels"
            value={draft.thinkingLevels === undefined ? "auto" : "custom"}
            onChange={(e) => patch("thinkingLevels", e.target.value === "auto" ? undefined : [...(inherited?.thinkingLevels || [])])}
            options={[
              { value: "auto", label: "Auto — follow the primary model" },
              { value: "custom", label: "Custom" },
            ]}
            disabled={saving}
            hint={`Auto: ${inherited?.thinkingLevels?.join(", ") || "no thinking levels declared"}`}
          />
          {draft.thinkingLevels !== undefined && (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {COMBO_THINKING_LEVELS.map((level) => (
                <label key={level} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.thinkingLevels.includes(level)}
                    disabled={saving}
                    onChange={(e) => patch("thinkingLevels", e.target.checked
                      ? [...draft.thinkingLevels, level]
                      : draft.thinkingLevels.filter((entry) => entry !== level))}
                    className="h-4 w-4 rounded accent-primary"
                  />
                  {level}
                </label>
              ))}
            </div>
          )}
        </section>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
