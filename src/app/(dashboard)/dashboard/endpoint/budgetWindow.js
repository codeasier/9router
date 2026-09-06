// UTC budget-window labels for the API Keys dashboard.
// Windows match keyPolicy.periodWindowMs: day midnight, ISO week Monday, month 1st.

export const PERIOD_LABELS = { day: "daily", week: "weekly", month: "monthly" };

export const UTC_WINDOW_RULE =
  "UTC windows: daily 00:00 · weekly Monday 00:00 · monthly 1st 00:00";

export function policyToFormState(policy) {
  const budgets = Array.isArray(policy?.budgets)
    ? policy.budgets.map((b) => ({
        provider: b.provider || "*",
        limitUsd: String(b.limitUsd ?? ""),
        period: b.period || "day",
      }))
    : [];
  return {
    budgets,
    maxConcurrent: policy?.maxConcurrent != null ? String(policy.maxConcurrent) : "",
    breakerMode: policy?.breaker?.mode === "period" ? "period" : "fixed",
    breakerMinutes: policy?.breaker?.durationMinutes != null
      ? String(policy.breaker.durationMinutes)
      : "5",
  };
}

export function formatUtcDateTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatRemaining(endMs, now = Date.now()) {
  if (!Number.isFinite(endMs)) return "";
  const ms = endMs - now;
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours < 72) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

export function formatRefreshAt(endMs, now = Date.now()) {
  const stamp = formatUtcDateTime(endMs);
  if (!stamp) return "";
  const remaining = formatRemaining(endMs, now);
  return remaining ? `${stamp} (${remaining})` : stamp;
}
