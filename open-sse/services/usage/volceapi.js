/**
 * 火山网关 usage — personal Bearer key against the unified gateway root.
 * Local day/week/month credit caps are configured defaults, not upstream quota.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber, U } from "./shared.js";
import {
  VOLCEAPI_API_ROOT,
  VOLCEAPI_TIMEZONE,
  VOLCEAPI_WINDOWS,
  VOLCEAPI_WINDOW_LABELS,
} from "../../config/volceapi.js";
import {
  estimateModelCredit,
  findModelMeta,
  indexModelsById,
  resetAtForWindow,
  resolveVolceapiLimits,
  roundCredit,
} from "./volceapiCredit.js";

const API_ROOT = U("volceapi").url || VOLCEAPI_API_ROOT;

// A quota refresh asks this gateway for 10 endpoints per account, and the
// dashboard fires every account at once. The gateway answers a burst with
// `500 function_dial_timeout` on an arbitrary subset, so one failed request
// used to blank a whole day/week/month window. Serialize per-request work,
// retry transient answers and let a timeout fail fast instead of hanging.
const REQUEST_TIMEOUT_MS = 5000;
const REQUEST_MAX_ATTEMPTS = 3;
const REQUEST_BUDGET_MS = 12000;
const RETRY_BASE_DELAY_MS = 300;
const MAX_IN_FLIGHT = 12;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

function jsonResponse(response) {
  return response.json().catch(() => null);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, apiKey, proxyOptions) {
  try {
    const response = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      proxyOptions,
    );
    return {
      ok: response.ok,
      status: response.status,
      data: await jsonResponse(response),
    };
  } catch (error) {
    // status 0 marks a transport failure (timeout, reset, proxy) rather than
    // an upstream answer — retryable, and never an auth verdict.
    return { ok: false, status: 0, data: null, error: error?.message || String(error) };
  }
}

export function isRetryableVolceapiFailure(result) {
  if (!result || result.status === 0) return true;
  if (RETRYABLE_STATUSES.has(result.status)) return true;
  return result.status >= 500 && result.status <= 599;
}

async function fetchJsonWithRetry(url, apiKey, proxyOptions) {
  const startedAt = Date.now();
  let result = null;
  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
    // The slot covers the request only — a retry backoff must not hold a
    // concurrency slot idle while other endpoints wait.
    result = await withSlot(() => fetchJson(url, apiKey, proxyOptions));
    if (result.ok || !isRetryableVolceapiFailure(result) || attempt === REQUEST_MAX_ATTEMPTS) break;
    // Full jitter keeps the retries of one refresh from landing together.
    const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * RETRY_BASE_DELAY_MS;
    // Never let retries stretch one endpoint past the budget: a slow upstream
    // would otherwise hold the whole card hostage.
    if (Date.now() - startedAt + delay > REQUEST_BUDGET_MS) break;
    await sleep(delay);
  }
  return result;
}

/**
 * Shared in-flight ceiling for every usage request in this process, so that
 * refreshing seven accounts does not become a 70-request burst against a
 * gateway that answers bursts with `function_dial_timeout`.
 */
let inFlight = 0;
const pending = [];

async function withSlot(task) {
  if (inFlight >= MAX_IN_FLIGHT) {
    // A finishing task hands its slot straight to this waiter, so the count
    // never dips and lets a fresh caller overshoot the ceiling.
    await new Promise((resolve) => pending.push(resolve));
  } else {
    inFlight += 1;
  }
  try {
    return await task();
  } finally {
    const next = pending.shift();
    if (next) next();
    else inFlight -= 1;
  }
}

function describeVolceapiFailure(result) {
  if (!result) return "no response";
  if (result.error) return result.error;
  const code = result.data?.error_code;
  const message = result.data?.error_message;
  const detail = [code, message].filter(Boolean).join(" ");
  return detail ? `${result.status} ${detail}` : `HTTP ${result.status}`;
}

function summarizeVolceapiFailures(failed) {
  const tally = new Map();
  for (const item of failed) {
    const label = describeVolceapiFailure(item.result);
    tally.set(label, (tally.get(label) || 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => (count > 1 ? `${label} x${count}` : label))
    .join("; ");
}

function usageUrl(path, query = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function summaryTokens(summary) {
  const data = summary?.data && typeof summary.data === "object" ? summary.data : summary;
  if (!data || typeof data !== "object") return null;
  const total = toFiniteNumber(data.total_tokens, NaN);
  if (!Number.isFinite(total)) return null;
  return {
    reqTokens: toFiniteNumber(data.req_tokens, 0),
    rspTokens: toFiniteNumber(data.rsp_tokens, 0),
    totalTokens: total,
    cachedTokens: toFiniteNumber(data.cached_tokens, 0),
    cacheHitRate: Number.isFinite(Number(data.cache_hit_rate)) ? Number(data.cache_hit_rate) : null,
    requestCount: toFiniteNumber(data.request_count, 0),
    date: typeof summary?.date === "string" ? summary.date : null,
    timezone: typeof summary?.timezone === "string" ? summary.timezone : VOLCEAPI_TIMEZONE,
  };
}

function listRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function buildWindowDetails({ window, summary, byModel, byProvider, modelIndex }) {
  const tokens = summaryTokens(summary);
  const timezone = tokens?.timezone || VOLCEAPI_TIMEZONE;
  const date = tokens?.date;
  const incompleteReasons = [];
  if (!tokens) incompleteReasons.push(`summary-${window}`);

  const modelRows = [];
  let credit = 0;
  let creditComplete = Boolean(tokens) && Array.isArray(byModel);
  if (!Array.isArray(byModel)) {
    incompleteReasons.push(`by-model-${window}`);
    creditComplete = false;
  } else if (tokens && tokens.totalTokens > 0 && byModel.length === 0) {
    incompleteReasons.push(`by-model-empty-${window}`);
    creditComplete = false;
  } else {
    for (const row of byModel || []) {
      const modelId = typeof row?.model === "string" ? row.model : null;
      if (!modelId) {
        creditComplete = false;
        incompleteReasons.push(`by-model-row-${window}`);
        continue;
      }
      const meta = findModelMeta(modelIndex, modelId);
      const estimated = estimateModelCredit(row, meta);
      const usedTokens = toFiniteNumber(row.total_tokens, 0);
      if (!meta && usedTokens > 0) {
        creditComplete = false;
        incompleteReasons.push(`model-meta-${modelId}`);
      }
      if (!estimated.complete) {
        creditComplete = false;
        if (estimated.reason) incompleteReasons.push(`${estimated.reason}:${modelId}`);
      } else {
        credit += estimated.credit;
      }
      modelRows.push({
        model: modelId,
        totalTokens: toFiniteNumber(row.total_tokens, 0),
        requestCount: toFiniteNumber(row.request_count, 0),
        share: Number.isFinite(Number(row.share)) ? Number(row.share) : null,
        cacheHitRate: Number.isFinite(Number(row.cached_tokens)) && toFiniteNumber(row.req_tokens, 0) > 0
          ? toFiniteNumber(row.cached_tokens, 0) / toFiniteNumber(row.req_tokens, 0)
          : (Number.isFinite(Number(row.cache_hit_rate)) ? Number(row.cache_hit_rate) : null),
        credit: estimated.complete ? estimated.credit : null,
        creditComplete: estimated.complete,
      });
    }
  }

  const providerRows = (Array.isArray(byProvider) ? byProvider : []).map((row) => ({
    provider: typeof row?.provider === "string" ? row.provider : "unknown",
    totalTokens: toFiniteNumber(row.total_tokens, 0),
    requestCount: toFiniteNumber(row.request_count, 0),
    share: Number.isFinite(Number(row.share)) ? Number(row.share) : null,
  }));
  if (!Array.isArray(byProvider)) incompleteReasons.push(`by-provider-${window}`);

  return {
    window,
    tokens,
    credit: roundCredit(credit),
    creditComplete,
    incompleteReasons,
    resetAt: resetAtForWindow(window, date, timezone),
    byModel: modelRows,
    byProvider: providerRows,
  };
}

export async function getVolceapiUsage(apiKey = null, proxyOptions = null, providerSpecificData = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "火山网关 API key not available. Add a key to view usage." };
  }

  const key = apiKey.trim();
  try {
    const requests = [];
    for (const window of VOLCEAPI_WINDOWS) {
      requests.push({ key: `summary:${window}`, url: usageUrl("/usage/summary", { window }) });
      requests.push({ key: `by-model:${window}`, url: usageUrl("/usage/by-model", { window }) });
      requests.push({ key: `by-provider:${window}`, url: usageUrl("/usage/by-provider", { window }) });
    }
    requests.push({ key: "models", url: usageUrl("/models") });

    const settled = await Promise.all(
      requests.map((req) => fetchJsonWithRetry(req.url, key, proxyOptions)),
    );
    const byKey = {};
    const failed = [];
    let sawAuthError = false;
    let sawOk = false;
    requests.forEach((req, index) => {
      const result = settled[index];
      byKey[req.key] = result;
      if (result.status === 401 || result.status === 403) sawAuthError = true;
      if (result.ok) sawOk = true;
      if (!result.ok) failed.push({ request: req.key, result });
    });
    const failureSummary = summarizeVolceapiFailures(failed);

    if (sawAuthError && !sawOk) {
      return {
        plan: "火山网关",
        message: "火山网关 authentication failed. Check the API key.",
      };
    }

    const modelIndex = byKey.models?.ok ? indexModelsById(byKey.models.data) : new Map();
    if (!byKey.models?.ok) {
      // Coefficients unavailable — credit rows stay omitted.
    }

    const details = {
      timezone: VOLCEAPI_TIMEZONE,
      limits: resolveVolceapiLimits(providerSpecificData),
      windows: {},
      byModel: {},
      byProvider: {},
      estimateComplete: true,
      incompleteReasons: [],
    };
    if (failed.length) {
      details.failedRequests = failed.map(({ request, result }) => ({
        request,
        status: result.status,
        errorCode: result.data?.error_code ?? null,
        error: result.error ?? null,
      }));
    }
    const quotas = {};

    for (const window of VOLCEAPI_WINDOWS) {
      const built = buildWindowDetails({
        window,
        summary: byKey[`summary:${window}`]?.ok ? byKey[`summary:${window}`].data : null,
        byModel: byKey[`by-model:${window}`]?.ok ? listRows(byKey[`by-model:${window}`].data) : null,
        byProvider: byKey[`by-provider:${window}`]?.ok ? listRows(byKey[`by-provider:${window}`].data) : null,
        modelIndex,
      });
      const label = VOLCEAPI_WINDOW_LABELS[window];
      details.windows[window] = {
        tokens: built.tokens,
        credit: built.credit,
        creditComplete: built.creditComplete,
        resetAt: built.resetAt,
        incompleteReasons: built.incompleteReasons,
      };
      details.byModel[window] = built.byModel;
      details.byProvider[window] = built.byProvider;
      if (!built.creditComplete) {
        details.estimateComplete = false;
        details.incompleteReasons.push(...built.incompleteReasons);
      }

      if (built.tokens) {
        quotas[`Tokens (${label})`] = {
          used: built.tokens.totalTokens,
          total: 0,
          resetAt: built.resetAt,
          unlimited: true,
          budgetKind: "tokens",
          cacheHitRate: built.tokens.cacheHitRate,
          requestCount: built.tokens.requestCount,
        };
      }

      const hasCreditEstimate = built.creditComplete
        || (Array.isArray(built.byModel) && built.byModel.some((row) => row.creditComplete));
      if (hasCreditEstimate) {
        const limit = details.limits[window];
        const used = Number.isFinite(built.credit) ? built.credit : 0;
        const row = {
          used,
          total: limit,
          resetAt: built.resetAt,
          unlimited: false,
          budgetKind: "local-cap",
        };
        if (built.creditComplete && limit > 0) {
          row.remainingPercentage = Math.max(0, Math.round(((limit - used) / limit) * 100));
        } else {
          row.incomplete = true;
        }
        quotas[`Credits (${label})`] = row;
      }
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan: "火山网关",
        message: `火山网关 usage API did not return usable day/week/month data${failureSummary ? ` (${failureSummary})` : ""}.`,
        // Transient means "try again later", which lets the dashboard keep the
        // last good snapshot instead of blanking the card.
        transient: failed.length > 0,
        details,
      };
    }

    const incompleteWindows = VOLCEAPI_WINDOWS.filter((window) => details.windows[window] && !details.windows[window].creditComplete);
    const baseNote = details.estimateComplete
      ? "Credits vs local caps (day 150 / week 450 / month 1000 by default). Token usage is in details — not a quota."
      : incompleteWindows.length
        ? `Credit estimate incomplete for ${incompleteWindows.join(", ")} — remaining is hidden for those windows until daily tokens and date-effective coefficients are available.`
        : "Credit estimate incomplete — remaining is hidden until daily tokens and date-effective coefficients are available.";
    // Say what actually broke: a bare "incomplete" hides gateway timeouts.
    const note = failureSummary
      ? `${baseNote} Upstream failed ${failed.length}/${requests.length} requests after ${REQUEST_MAX_ATTEMPTS} attempts: ${failureSummary}.`
      : baseNote;

    return {
      plan: "火山网关",
      quotas,
      note,
      // Signals the dashboard that holes in this payload are upstream blips,
      // not real zero usage — it keeps the last known rows for those windows.
      transient: failed.length > 0,
      details,
    };
  } catch (error) {
    return { message: `火山网关 error: ${error.message}` };
  }
}
