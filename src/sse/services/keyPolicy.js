// Per-API-key policy engine: provider budgets (period-scoped spend caps),
// concurrency limits (fast-fail 429), and circuit breaker with configurable
// recovery (fixed duration or until-period-end).
//
// Policy shape (stored as JSON in apiKeys.policy):
//   {
//     budgets: [{ provider: "codex"|"*" , limitUsd: 5, period: "day"|"week"|"month" }],
//     maxConcurrent: 10,
//     breaker: { mode: "fixed"|"period", durationMinutes: 5 }   // recovery strategy
//   }
//
// All mutable state lives on `global._keyPolicyState` (survives Next.js dev
// hot-reload, mirrors usageRepo.js pattern). Breaker/concurrency state is
// in-memory only — losing it on restart re-arms checks from usage tables.

import * as log from "../utils/logger.js";

// ─── Constants ───────────────────────────────────────────────────────────
const BUDGET_CACHE_TTL_MS = 30_000;   // re-read SUM(cost) from DB at most this often
const LEASE_MAX_MS = 10 * 60 * 1000;  // hard cap: any acquired slot must release by this
const BREAKER_MIN_DURATION_MS = 30_000;
const BREAKER_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_FLOOR = 1;
const MAX_CONCURRENT_CEIL = 500;

if (!global._keyPolicyState) {
  global._keyPolicyState = {
    breaker: new Map(),   // apiKey string -> { untilMs, reason }  (whole-key breaker)
    pb: new Map(),        // `${apiKey}|${provider}` -> { untilMs, reason } (provider-budget breaker)
    inflight: new Map(),  // apiKey string -> count of in-flight requests
    budgetCache: new Map(), // `${apiKey}|${provider}|${startMs}|${endMs}` -> cached spend
    reservations: new Map(), // `${apiKey}|${scope}|${period}|${window}` -> Map(request token, USD)
    policyCache: new Map(), // apiKey string -> { expiresAt, policy }
  };
}
const state = global._keyPolicyState;
// Preserve state created by an older hot-reloaded module in the same process.
state.reservations ??= new Map();

function pruneExpiredReservations(now) {
  for (const reservationKey of state.reservations.keys()) {
    const endMs = Number(reservationKey.slice(reservationKey.lastIndexOf("|") + 1));
    if (Number.isFinite(endMs) && endMs <= now) state.reservations.delete(reservationKey);
  }
}

// ─── Policy parsing / normalization ──────────────────────────────────────
// Returns a normalized policy object or null (no policy / invalid → no limits).
export function normalizePolicy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const policy = {};

  if (Array.isArray(raw.budgets) && raw.budgets.length > 0) {
    const budgets = [];
    for (const b of raw.budgets) {
      if (!b || typeof b !== "object") continue;
      const provider = typeof b.provider === "string" && b.provider.trim() ? b.provider.trim() : null;
      const limitUsd = Number(b.limitUsd);
      const period = b.period === "week" || b.period === "month" ? b.period : "day";
      if (!provider || !Number.isFinite(limitUsd) || limitUsd <= 0) continue;
      budgets.push({ provider, limitUsd, period });
    }
    if (budgets.length > 0) policy.budgets = budgets;
  }

  const mc = Number(raw.maxConcurrent);
  if (Number.isFinite(mc) && mc >= MAX_CONCURRENT_FLOOR) {
    policy.maxConcurrent = Math.min(Math.floor(mc), MAX_CONCURRENT_CEIL);
  }

  if (raw.breaker && typeof raw.breaker === "object") {
    const mode = raw.breaker.mode === "period" ? "period" : "fixed";
    let durationMinutes = Number(raw.breaker.durationMinutes);
    if (!Number.isFinite(durationMinutes)) durationMinutes = 5;
    durationMinutes = Math.min(Math.max(durationMinutes, BREAKER_MIN_DURATION_MS / 60000), BREAKER_MAX_DURATION_MS / 60000);
    policy.breaker = { mode, durationMinutes };
  }

  return Object.keys(policy).length > 0 ? policy : null;
}

// ─── Period window (UTC) ─────────────────────────────────────────────────
// Budget windows are computed in UTC so ISO-string comparisons against
// usageHistory.timestamp stay index-friendly. Returns [startMs, endMs).
export function periodWindowMs(period, now = Date.now()) {
  const d = new Date(now);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === "week") {
    // ISO week: Monday as first day, UTC
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    return [startMs - (dow - 1) * 86400000, startMs - (dow - 1) * 86400000 + 7 * 86400000];
  }
  if (period === "month") {
    return [
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
    ];
  }
  return [startMs, startMs + 86400000]; // day
}

// ─── Breaker ─────────────────────────────────────────────────────────────
// mode "fixed": re-arms for durationMinutes, then re-checks (if still over
// budget, trips again at next request).
// mode "period": stays open until the current budget window rolls over.
export function breakerUntil(policy, period, now = Date.now()) {
  const breaker = policy?.breaker;
  if (breaker?.mode === "period") {
    const [, endMs] = periodWindowMs(period || "day", now);
    return endMs;
  }
  const minutes = breaker?.durationMinutes ?? 5;
  return now + minutes * 60_000;
}

function tripBreaker(map, mapKey, untilMs, reason) {
  map.set(mapKey, { untilMs, reason });
  log.warn("KEYPOLICY", `breaker OPEN ${mapKey} until ${new Date(untilMs).toISOString()} (${reason})`);
}

function breakerOpen(map, mapKey, now = Date.now()) {
  const entry = map.get(mapKey);
  if (!entry) return null;
  if (entry.untilMs <= now) {
    map.delete(mapKey);
    return null;
  }
  return entry;
}

// ─── Budget query (cached SUM over usageHistory) ─────────────────────────
let _querySpentUsd = null; // injectable for tests

export function _setBudgetQuery(fn) {
  _querySpentUsd = fn;
}

async function getSpentUsd(apiKeyValue, provider, startMs, endMs, now = Date.now()) {
  const cacheKey = `${apiKeyValue}|${provider}|${startMs}|${endMs}`;
  const cached = state.budgetCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.spentUsd;

  let spentUsd = 0;
  try {
    if (_querySpentUsd) {
      spentUsd = await _querySpentUsd(apiKeyValue, provider, startMs, endMs);
    } else {
      const { getAdapter } = await import("@/lib/db/driver.js");
      const db = await getAdapter();
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();
      if (provider === "*") {
        const row = db.get(
          `SELECT COALESCE(SUM(cost), 0) AS spent FROM usageHistory WHERE apiKey = ? AND timestamp >= ? AND timestamp < ?`,
          [apiKeyValue, startIso, endIso]
        );
        spentUsd = row?.spent ?? 0;
      } else {
        const row = db.get(
          `SELECT COALESCE(SUM(cost), 0) AS spent FROM usageHistory WHERE apiKey = ? AND timestamp >= ? AND timestamp < ? AND provider = ?`,
          [apiKeyValue, startIso, endIso, provider]
        );
        spentUsd = row?.spent ?? 0;
      }
    }
  } catch (e) {
    log.warn("KEYPOLICY", `budget query failed (fail-open): ${e.message}`);
    return 0;
  }

  state.budgetCache.set(cacheKey, {
    expiresAt: now + BUDGET_CACHE_TTL_MS,
    windowEndMs: endMs,
    spentUsd,
  });
  // Opportunistic prune: entries are few (per key×provider×window), but
  // stale windows should not accumulate across restarts-free long runs.
  if (state.budgetCache.size > 512) {
    for (const [k, v] of state.budgetCache) {
      if (v.expiresAt <= now) state.budgetCache.delete(k);
    }
  }
  return spentUsd;
}

// Called from usageRepo.saveRequestUsage on every real insert to keep the
// in-memory budget ahead of the TTL cache.
export function bumpBudgetCache(apiKeyValue, provider, costUsd, timestamp = Date.now()) {
  if (!apiKeyValue || !Number.isFinite(costUsd) || costUsd === 0) return;
  const usageMs = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const now = Date.now();
  for (const [cacheKey, entry] of state.budgetCache) {
    if (entry.expiresAt <= now) continue;
    const cacheParts = cacheKey.split("|");
    const endMsStr = cacheParts.pop();
    const startMsStr = cacheParts.pop();
    const prov = cacheParts.pop();
    const key = cacheParts.join("|");
    if (key !== apiKeyValue) continue;
    if (prov !== "*" && provider && prov !== provider) continue;
    const startMs = Number(startMsStr);
    if (
      !Number.isFinite(usageMs)
      || !Number.isFinite(startMs)
      || !Number.isFinite(Number(endMsStr))
      || !Number.isFinite(entry.windowEndMs)
    ) {
      // Old hot-reload cache entries lack window bounds; force a fresh DB read.
      state.budgetCache.delete(cacheKey);
      continue;
    }
    if (usageMs < startMs || usageMs >= entry.windowEndMs) continue;
    entry.spentUsd += costUsd;
  }
}

// Invalidate cached policy/budget lookups when a key is edited.
export function invalidateKeyPolicy(apiKeyValue) {
  if (!apiKeyValue) return;
  for (const k of state.budgetCache.keys()) {
    if (k.startsWith(`${apiKeyValue}|`)) state.budgetCache.delete(k);
  }
  state.policyCache.delete(apiKeyValue);
}

// Clear breaker state for a key (whole-key + per-provider). Used for manual
// reset after a quota has been hit, and automatically when a policy limit is
// raised so the new limit takes effect without waiting for the cooldown.
export function clearKeyBreaker(apiKeyValue) {
  if (!apiKeyValue) return;
  state.breaker.delete(apiKeyValue);
  for (const k of state.pb.keys()) {
    if (k.startsWith(`${apiKeyValue}|`)) state.pb.delete(k);
  }
}

// Full reset for a key: breaker + budget/policy caches. Spend itself stays
// in usageHistory (recomputed from DB on next check), but the breaker cooldown
// is cleared so a raised limit takes effect immediately.
export function resetKeyPolicyState(apiKeyValue) {
  if (!apiKeyValue) return;
  clearKeyBreaker(apiKeyValue);
  for (const k of state.budgetCache.keys()) {
    if (k.startsWith(`${apiKeyValue}|`)) state.budgetCache.delete(k);
  }
  for (const k of state.reservations.keys()) {
    if (k.startsWith(`${apiKeyValue}|`)) state.reservations.delete(k);
  }
  state.policyCache.delete(apiKeyValue);
  log.warn("KEYPOLICY", `reset state for ${apiKeyValue.slice(0, 8)}…`);
}

// ─── Checks ──────────────────────────────────────────────────────────────

/**
 * Check provider budget for a key. Returns { ok: true } or
 * { ok: false, status: 429, retryAfterMs, message }.
 * When provider is null (unknown at check time), only "*" budgets are checked.
 */
export async function checkBudget(apiKeyValue, policy, provider, now = Date.now(), pendingCostUsd = 0) {
  const budgets = policy?.budgets;
  if (!budgets || budgets.length === 0) return { ok: true };

  // Whole-key breaker (covers all providers)
  const open = breakerOpen(state.breaker, apiKeyValue, now);
  if (open) {
    return {
      ok: false, status: 429,
      retryAfterMs: open.untilMs - now,
      message: `API key circuit breaker open (${open.reason}); retry after ${new Date(open.untilMs).toISOString()}`,
    };
  }

  for (const b of budgets) {
    const matches = b.provider === "*" || b.provider === provider;
    if (!matches) continue;

    // Per-provider breaker
    if (b.provider !== "*") {
      const pbOpen = breakerOpen(state.pb, `${apiKeyValue}|${b.provider}`, now);
      if (pbOpen) {
        return {
          ok: false, status: 429,
          retryAfterMs: pbOpen.untilMs - now,
          message: `Circuit breaker open for provider "${b.provider}" (${pbOpen.reason}); retry after ${new Date(pbOpen.untilMs).toISOString()}`,
        };
      }
    }

    const [startMs, endMs] = periodWindowMs(b.period, now);
    const spentUsd = await getSpentUsd(apiKeyValue, b.provider, startMs, endMs, now);
    if (spentUsd >= b.limitUsd) {
      const reason = `budget exceeded: $${spentUsd.toFixed(4)} / $${b.limitUsd} per ${b.period} on ${b.provider === "*" ? "all providers" : b.provider}`;
      const untilMs = breakerUntil(policy, b.period, now);
      if (b.provider === "*") {
        tripBreaker(state.breaker, apiKeyValue, untilMs, reason);
      } else {
        tripBreaker(state.pb, `${apiKeyValue}|${b.provider}`, untilMs, reason);
      }
      return {
        ok: false, status: 429,
        retryAfterMs: untilMs - now,
        message: `API key ${reason}; circuit breaker until ${new Date(untilMs).toISOString()}`,
      };
    }
    const projectedUsd = spentUsd + (Number.isFinite(pendingCostUsd) && pendingCostUsd >= 0 ? pendingCostUsd : 0);
    if (projectedUsd > b.limitUsd) {
      return {
        ok: false, status: 429, retryAfterMs: 1000,
        message: `API key projected budget would exceed $${b.limitUsd} per ${b.period} on ${b.provider === "*" ? "all providers" : b.provider}; retry shortly`,
      };
    }
  }
  return { ok: true };
}

/**
 * Try to acquire a concurrency slot. Returns { ok: true } or
 * { ok: false, status: 429, retryAfterMs: 1000, message } (fast-fail, no queue).
 */
export function acquireSlot(apiKeyValue, policy, now = Date.now()) {
  const max = policy?.maxConcurrent;
  if (!max) return { ok: true };
  const cur = state.inflight.get(apiKeyValue) || 0;
  if (cur >= max) {
    return {
      ok: false, status: 429, retryAfterMs: 1000,
      message: `Concurrency limit reached (${cur}/${max} in-flight requests for this API key)`,
    };
  }
  state.inflight.set(apiKeyValue, cur + 1);
  return { ok: true };
}

export function releaseSlot(apiKeyValue) {
  const cur = state.inflight.get(apiKeyValue) || 0;
  if (cur <= 1) state.inflight.delete(apiKeyValue);
  else state.inflight.set(apiKeyValue, cur - 1);
}

// ─── Response helpers ────────────────────────────────────────────────────
export function policyErrorResponse({ status, message, retryAfterMs }) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Retry-After": String(Math.max(1, Math.ceil((retryAfterMs || 1000) / 1000))),
  };
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status === 429 ? "rate_limit_error" : "invalid_request_error",
        code: status === 429 ? "rate_limit_exceeded" : "policy_violation",
      },
    }),
    { status, headers }
  );
}

/**
 * Wrap a handler Response so the concurrency slot releases exactly once when
 * the client-side body finishes (done/cancel/error), with a lease-timeout
 * safety net for streams that are never consumed.
 */
export function wrapResponseForSlot(response, apiKeyValue) {
  if (!response?.body) {
    releaseSlot(apiKeyValue);
    return response;
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    clearTimeout(leaseTimer);
    releaseSlot(apiKeyValue);
  };
  const leaseTimer = setTimeout(releaseOnce, LEASE_MAX_MS);
  leaseTimer.unref?.();

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          releaseOnce();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        releaseOnce();
        controller.error(err);
      }
    },
    cancel(reason) {
      releaseOnce();
      return reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Test hook
export function _resetKeyPolicyState() {
  state.breaker.clear();
  state.pb.clear();
  state.inflight.clear();
  state.budgetCache.clear();
  state.reservations.clear();
  state.policyCache.clear();
}

// ─── Live status snapshot (dashboard) ────────────────────────────────────
/**
 * Snapshot of a key's live policy state: current in-flight count, spend in
 * each budget's active window (+ day/week/month usage summary), and open
 * breakers. Reads through the same budget cache as enforcement, so polling
 * is cheap.
 */
export async function getKeyPolicyStatus(apiKeyValue, { skipCache = false } = {}) {
  if (!apiKeyValue) return null;
  const policy = await getPolicyForApiKey(apiKeyValue, { skipCache });
  const now = Date.now();

  const keyBreaker = breakerOpen(state.breaker, apiKeyValue, now);
  const providerBreakers = [];
  for (const [mapKey, entry] of state.pb) {
    if (entry.untilMs <= now) continue; // stale; pruned on next enforcement
    const prefix = `${apiKeyValue}|`;
    if (!mapKey.startsWith(prefix)) continue;
    providerBreakers.push({
      provider: mapKey.slice(prefix.length),
      untilMs: entry.untilMs,
      reason: entry.reason,
    });
  }

  const budgets = [];
  if (policy?.budgets?.length) {
    for (const b of policy.budgets) {
      const [startMs, endMs] = periodWindowMs(b.period, now);
      const spentUsd = await getSpentUsd(apiKeyValue, b.provider, startMs, endMs, now);
      budgets.push({
        provider: b.provider,
        period: b.period,
        limitUsd: b.limitUsd,
        spentUsd: Math.round((spentUsd + Number.EPSILON) * 1e6) / 1e6,
        windowStartMs: startMs,
        windowEndMs: endMs,
      });
    }
  }

  const usage = {};
  for (const period of ["day", "week", "month"]) {
    const [startMs, endMs] = periodWindowMs(period, now);
    usage[period] = Math.round((await getSpentUsd(apiKeyValue, "*", startMs, endMs, now) + Number.EPSILON) * 1e6) / 1e6;
  }

  return {
    hasPolicy: !!policy,
    maxConcurrent: policy?.maxConcurrent ?? null,
    inflight: state.inflight.get(apiKeyValue) || 0,
    budgets,
    usage,
    breaker: keyBreaker ? { scope: "key", untilMs: keyBreaker.untilMs, reason: keyBreaker.reason } : null,
    providerBreakers,
  };
}

// ─── Guard layer (used by request handlers) ─────────────────────────────
// Policy lookup with a short TTL cache to keep the hot path off SQLite.
// invalidateKeyPolicy() clears it when a key is edited via the dashboard.
const POLICY_CACHE_TTL_MS = 15_000;

export async function getPolicyForApiKey(apiKeyValue, { skipCache = false } = {}) {
  if (!apiKeyValue) return null;
  const now = Date.now();
  if (!skipCache) {
    const cached = state.policyCache.get(apiKeyValue);
    if (cached && cached.expiresAt > now) return cached.policy;
  }
  // Dynamic import: keeps this module importable under partial mocks of
  // @/lib/localDb in tests, and avoids a static dependency cycle.
  const { getApiKeyByKey } = await import("@/lib/localDb");
  const record = await getApiKeyByKey(apiKeyValue);
  const policy = normalizePolicy(record?.policy);
  state.policyCache.set(apiKeyValue, { expiresAt: now + POLICY_CACHE_TTL_MS, policy });
  return policy;
}

// Resolve alias → registry provider id so budget keys match usageHistory.provider
async function resolveProvider(provider) {
  if (!provider) return null;
  try {
    const { resolveProviderId } = await import("@/shared/constants/providers.js");
    return resolveProviderId(provider) || provider;
  } catch {
    return provider;
  }
}

/**
 * Entry-point guard: whole-key breaker + matching budgets + concurrency slot.
 * `provider` may be null when unknown at entry (combo etc.) — then only
 * "*" budgets and the whole-key breaker apply.
 *
 * Returns { ok: false, response } to reject, or
 * { ok: true, policy, wrap(response) } where wrap() releases the slot when
 * the response body finishes (identity when no concurrency limit configured).
 */
export async function enforceKeyPolicy(apiKeyValue, provider = null) {
  if (!apiKeyValue) return { ok: true, policy: null, wrap: (r) => r };
  const policy = await getPolicyForApiKey(apiKeyValue);
  if (!policy) return { ok: true, policy: null, wrap: (r) => r };

  const providerId = await resolveProvider(provider);
  const budgetResult = await checkBudget(apiKeyValue, policy, providerId);
  if (!budgetResult.ok) {
    return { ok: false, response: policyErrorResponse(budgetResult), policy };
  }

  const slot = acquireSlot(apiKeyValue, policy);
  if (!slot.ok) {
    return { ok: false, response: policyErrorResponse(slot), policy };
  }

  const needsWrap = !!policy.maxConcurrent;
  return {
    ok: true,
    policy,
    wrap: (response) => (needsWrap ? wrapResponseForSlot(response, apiKeyValue) : response),
  };
}

/**
 * Per-attempt provider budget check (after the target provider is resolved,
 * e.g. inside handleSingleModelChat / combo fallback). Slot & whole-key
 * breaker were already enforced at entry. Returns a Response to reject with,
 * or null when the request may proceed.
 */
export async function checkProviderBudgetResponse(apiKeyValue, provider) {
  if (!apiKeyValue || !provider) return null;
  const policy = await getPolicyForApiKey(apiKeyValue);
  if (!policy?.budgets?.length) return null;
  const providerId = await resolveProvider(provider);
  // Only provider-specific budgets (skip "*": already checked at entry)
  const result = await checkBudget(apiKeyValue, { ...policy, budgets: policy.budgets.filter(b => b.provider !== "*") }, providerId);
  if (!result.ok) return policyErrorResponse(result);
  return null;
}

/**
 * Evaluate a resolved provider attempt against matching provider or wildcard
 * budgets. Unknown costs fail closed only when such a budget exists.
 */
export async function evaluateProviderBudget(apiKeyValue, provider, { costUsd, operation = "request" } = {}) {
  const noopRelease = () => {};
  const allowed = {
    budgetMatched: false,
    rejectionResponse: null,
    releaseReservation: noopRelease,
    accountingTimestamp: null,
  };
  if (!apiKeyValue || !provider) return allowed;

  const policy = await getPolicyForApiKey(apiKeyValue);
  if (!policy?.budgets?.length) return allowed;

  const providerId = await resolveProvider(provider);
  const matchingBudgets = policy.budgets.filter((budget) => budget.provider === "*" || budget.provider === providerId);
  if (matchingBudgets.length === 0) return allowed;

  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return {
      budgetMatched: true,
      rejectionResponse: policyErrorResponse({
        status: 403,
        message: `API key budget policy blocks ${operation} for provider "${providerId}" because its USD cost cannot be determined before the upstream request`,
      }),
      releaseReservation: noopRelease,
    };
  }

  const now = Date.now();
  pruneExpiredReservations(now);
  const accountingTimestamp = new Date(now).toISOString();
  const keyBreaker = breakerOpen(state.breaker, apiKeyValue, now);
  if (keyBreaker) {
    return {
      budgetMatched: true,
      rejectionResponse: policyErrorResponse({
        status: 429,
        retryAfterMs: keyBreaker.untilMs - now,
        message: `API key circuit breaker open (${keyBreaker.reason}); retry after ${new Date(keyBreaker.untilMs).toISOString()}`,
      }),
      releaseReservation: noopRelease,
    };
  }

  for (const budget of matchingBudgets) {
    if (budget.provider === "*") continue;
    const providerBreaker = breakerOpen(state.pb, `${apiKeyValue}|${budget.provider}`, now);
    if (providerBreaker) {
      return {
        budgetMatched: true,
        rejectionResponse: policyErrorResponse({
          status: 429,
          retryAfterMs: providerBreaker.untilMs - now,
          message: `Circuit breaker open for provider "${budget.provider}" (${providerBreaker.reason}); retry after ${new Date(providerBreaker.untilMs).toISOString()}`,
        }),
        releaseReservation: noopRelease,
      };
    }
  }

  const checks = await Promise.all(matchingBudgets.map(async (budget) => {
    const [startMs, endMs] = periodWindowMs(budget.period, now);
    const spentUsd = await getSpentUsd(apiKeyValue, budget.provider, startMs, endMs, now);
    const budgetCacheKey = `${apiKeyValue}|${budget.provider}|${startMs}|${endMs}`;
    const reservationKey = `${apiKeyValue}|${budget.provider}|${budget.period}|${startMs}|${endMs}`;
    return { budget, spentUsd, budgetCacheKey, reservationKey };
  }));

  // No await below this point: reservation checks and increments are atomic
  // with respect to other JavaScript tasks in this process.
  for (const check of checks) {
    const { budget } = check;
    const spentUsd = state.budgetCache.get(check.budgetCacheKey)?.spentUsd ?? check.spentUsd;
    if (spentUsd < budget.limitUsd) continue;
    const reason = `budget exceeded: $${spentUsd.toFixed(4)} / $${budget.limitUsd} per ${budget.period} on ${budget.provider === "*" ? "all providers" : budget.provider}`;
    const untilMs = breakerUntil(policy, budget.period, now);
    if (budget.provider === "*") {
      tripBreaker(state.breaker, apiKeyValue, untilMs, reason);
    } else {
      tripBreaker(state.pb, `${apiKeyValue}|${budget.provider}`, untilMs, reason);
    }
    return {
      budgetMatched: true,
      rejectionResponse: policyErrorResponse({
        status: 429,
        retryAfterMs: untilMs - now,
        message: `API key ${reason}; circuit breaker until ${new Date(untilMs).toISOString()}`,
      }),
      releaseReservation: noopRelease,
    };
  }

  for (const check of checks) {
    const { budget, reservationKey } = check;
    const spentUsd = state.budgetCache.get(check.budgetCacheKey)?.spentUsd ?? check.spentUsd;
    const scopeReservations = state.reservations.get(reservationKey);
    const reservedUsd = scopeReservations
      ? [...scopeReservations.values()].reduce((total, reservedCost) => total + reservedCost, 0)
      : 0;
    if (spentUsd + reservedUsd + costUsd <= budget.limitUsd) continue;
    return {
      budgetMatched: true,
      rejectionResponse: policyErrorResponse({
        status: 429,
        retryAfterMs: 1000,
        message: `API key projected budget would exceed $${budget.limitUsd} per ${budget.period} on ${budget.provider === "*" ? "all providers" : budget.provider}; retry shortly`,
      }),
      releaseReservation: noopRelease,
    };
  }

  const reservationKeys = [...new Set(checks.map(({ reservationKey }) => reservationKey))];
  const reservationToken = {};
  for (const reservationKey of reservationKeys) {
    let scopeReservations = state.reservations.get(reservationKey);
    if (!scopeReservations) {
      scopeReservations = new Map();
      state.reservations.set(reservationKey, scopeReservations);
    }
    scopeReservations.set(reservationToken, costUsd);
  }

  let released = false;
  const releaseReservation = () => {
    if (released) return;
    released = true;
    for (const reservationKey of reservationKeys) {
      const scopeReservations = state.reservations.get(reservationKey);
      if (!scopeReservations) continue;
      scopeReservations.delete(reservationToken);
      if (scopeReservations.size === 0) state.reservations.delete(reservationKey);
    }
  };

  return {
    budgetMatched: true,
    rejectionResponse: null,
    releaseReservation,
    accountingTimestamp,
  };
}
