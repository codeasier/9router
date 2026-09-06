// UTC budget-window labels for the API Keys dashboard.
// Windows match keyPolicy.periodWindowMs: day midnight, ISO week Monday, month 1st.

export const PERIOD_LABELS = { day: "daily", week: "weekly", month: "monthly" };

export const PERIOD_ALL_LABELS = {
  day: "today (all)",
  week: "week (all)",
  month: "month (all)",
};

export const UTC_WINDOW_RULE =
  "UTC windows: daily 00:00 · weekly Monday 00:00 · monthly 1st 00:00";

const PERIOD_ORDER = ["day", "week", "month"];
const OTHER_USD_EPSILON = 0.005;

// Same UTC windows as src/sse/services/keyPolicy.js periodWindowMs.
export function periodWindowMs(period, now = Date.now()) {
  const d = new Date(now);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === "week") {
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    return [startMs - (dow - 1) * 86400000, startMs - (dow - 1) * 86400000 + 7 * 86400000];
  }
  if (period === "month") {
    return [
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
    ];
  }
  return [startMs, startMs + 86400000];
}

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

export function formatUtcDate(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatUtcDateRange(startMs, endMs, now = Date.now()) {
  const start = formatUtcDate(startMs);
  const end = formatUtcDate(endMs);
  if (!start || !end) return "";
  const remaining = formatRemaining(endMs, now);
  return remaining ? `${start} – ${end} UTC (${remaining})` : `${start} – ${end} UTC`;
}

export function formatPeriodWindow(period, startMs, endMs, now = Date.now()) {
  if (period === "day") {
    const day = formatUtcDate(startMs);
    if (!day) return "";
    const remaining = formatRemaining(endMs, now);
    return remaining ? `${day} UTC (${remaining})` : `${day} UTC`;
  }
  return formatUtcDateRange(startMs, endMs, now);
}

export function previousMonthOverlapUtc(weekStartMs, monthStartMs) {
  if (!Number.isFinite(weekStartMs) || !Number.isFinite(monthStartMs) || weekStartMs >= monthStartMs) {
    return null;
  }
  const first = formatUtcDate(weekStartMs);
  const last = formatUtcDate(monthStartMs - 1);
  return first && last && first !== last ? `${first} – ${last}` : first || null;
}

function periodBounds(status, period, now) {
  const startMs = Number.isFinite(status?.usageStartMs?.[period])
    ? status.usageStartMs[period]
    : periodWindowMs(period, now)[0];
  const endMs = Number.isFinite(status?.usageResetMs?.[period])
    ? status.usageResetMs[period]
    : periodWindowMs(period, now)[1];
  return [startMs, endMs];
}

/**
 * Nest provider budgets under the matching UTC day/week/month total so
 * "week $376" and "codex $264/400" are parent/child, not sibling figures.
 *
 * "Other providers" = period total minus same-period non-wildcard budget
 * spend. Omitted when a "*" budget exists for that period (would overlap).
 */
export function buildSpendHierarchy(status, now = Date.now()) {
  const budgets = Array.isArray(status?.budgets) ? status.budgets : [];
  const usage = status?.usage || {};
  const byPeriod = { day: [], week: [], month: [] };
  for (const budget of budgets) {
    if (byPeriod[budget.period]) byPeriod[budget.period].push(budget);
  }

  const [weekStartMs] = periodBounds(status, "week", now);
  const [monthStartMs] = periodBounds(status, "month", now);
  const prevMonthOverlap = previousMonthOverlapUtc(weekStartMs, monthStartMs);

  return PERIOD_ORDER.map((period) => {
    const [startMs, endMs] = periodBounds(status, period, now);
    const rules = byPeriod[period];
    const scoped = rules.filter((budget) => budget.provider !== "*");
    const hasWildcard = rules.some((budget) => budget.provider === "*");
    const totalUsd = Number(usage[period]) || 0;
    const scopedSpent = scoped.reduce((sum, budget) => sum + (Number(budget.spentUsd) || 0), 0);
    const otherUsd = totalUsd - scopedSpent;
    return {
      period,
      totalUsd,
      startMs,
      endMs,
      prevMonthOverlap: period === "week" ? prevMonthOverlap : null,
      rules,
      otherUsd: scoped.length > 0 && !hasWildcard && otherUsd > OTHER_USD_EPSILON
        ? Math.round((otherUsd + Number.EPSILON) * 1e6) / 1e6
        : null,
    };
  });
}
