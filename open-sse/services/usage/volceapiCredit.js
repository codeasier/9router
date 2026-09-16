import {
  VOLCEAPI_CREDIT_PER_MILLION,
  VOLCEAPI_DEFAULT_LIMITS,
  VOLCEAPI_TIMEZONE,
} from "../../config/volceapi.js";

export function resolveVolceapiLimits(providerSpecificData) {
  const raw = providerSpecificData?.quotaLimits;
  const limits = { ...VOLCEAPI_DEFAULT_LIMITS };
  if (!raw || typeof raw !== "object") return limits;
  for (const key of Object.keys(VOLCEAPI_DEFAULT_LIMITS)) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

export function roundCredit(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

export function addCalendarDays(dateStr, days) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

export function nextWeekResetDate(dateStr) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const add = dow === 1 ? 7 : ((8 - dow) % 7 || 7);
  return addCalendarDays(dateStr, add);
}

export function nextMonthResetDate(dateStr) {
  const [year, month] = String(dateStr).split("-").map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

export function zonedMidnightIso(dateStr, timeZone = VOLCEAPI_TIMEZONE) {
  if (timeZone === "Asia/Shanghai") {
    return new Date(`${dateStr}T00:00:00+08:00`).toISOString();
  }
  return new Date(`${dateStr}T00:00:00Z`).toISOString();
}

export function resetAtForWindow(window, dateStr, timeZone = VOLCEAPI_TIMEZONE) {
  if (!dateStr) return null;
  if (window === "today") return zonedMidnightIso(addCalendarDays(dateStr, 1), timeZone);
  if (window === "week") return zonedMidnightIso(nextWeekResetDate(dateStr), timeZone);
  if (window === "month") return zonedMidnightIso(nextMonthResetDate(dateStr), timeZone);
  return null;
}

/**
 * Effective credit coefficient for a calendar date from /v1/models credit_history.
 * Never uses a later coefficient to backfill an earlier day.
 */
export function resolveCreditCoefficient(date, modelMeta) {
  if (!date || !modelMeta || typeof modelMeta !== "object") {
    return { coefficient: null, complete: false };
  }
  const history = Array.isArray(modelMeta.credit_history) ? modelMeta.credit_history : [];
  const dated = history
    .map((row) => ({
      from: typeof row?.from === "string" ? row.from : null,
      credit: Number(row?.credit),
    }))
    .filter((row) => row.from && Number.isFinite(row.credit))
    .sort((a, b) => a.from.localeCompare(b.from));

  if (dated.length) {
    if (date < dated[0].from) return { coefficient: null, complete: false };
    let coefficient = dated[0].credit;
    for (const row of dated) {
      if (row.from <= date) coefficient = row.credit;
      else break;
    }
    return { coefficient, complete: true };
  }

  const current = Number(modelMeta.credit);
  if (Number.isFinite(current)) return { coefficient: current, complete: true };
  return { coefficient: null, complete: false };
}

export function estimateModelCredit(modelUsage, modelMeta) {
  const daily = Array.isArray(modelUsage?.daily) ? modelUsage.daily : [];
  if (!daily.length) {
    return { credit: 0, complete: false, reason: "missing-daily" };
  }
  let credit = 0;
  for (const day of daily) {
    const date = typeof day?.date === "string" ? day.date : null;
    const tokens = Number(day?.total_tokens);
    if (!date || !Number.isFinite(tokens)) {
      return { credit: 0, complete: false, reason: "incomplete-daily" };
    }
    const { coefficient, complete } = resolveCreditCoefficient(date, modelMeta);
    if (!complete) return { credit: 0, complete: false, reason: "missing-coefficient" };
    credit += tokens * coefficient / VOLCEAPI_CREDIT_PER_MILLION;
  }
  return { credit: roundCredit(credit), complete: true };
}

export function indexModelsById(modelsPayload) {
  const list = Array.isArray(modelsPayload?.data)
    ? modelsPayload.data
    : Array.isArray(modelsPayload)
      ? modelsPayload
      : [];
  const index = new Map();
  for (const model of list) {
    if (model && typeof model.id === "string" && model.id) index.set(model.id, model);
  }
  return index;
}
