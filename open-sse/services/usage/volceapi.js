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
  indexModelsById,
  resetAtForWindow,
  resolveVolceapiLimits,
  roundCredit,
} from "./volceapiCredit.js";

const API_ROOT = U("volceapi").url || VOLCEAPI_API_ROOT;

function jsonResponse(response) {
  return response.json().catch(() => null);
}

async function fetchJson(url, apiKey, proxyOptions) {
  const response = await proxyAwareFetch(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    proxyOptions,
  );
  return {
    ok: response.ok,
    status: response.status,
    data: await jsonResponse(response),
  };
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
      const meta = modelIndex.get(modelId);
      if (!meta) {
        creditComplete = false;
        incompleteReasons.push(`model-meta-${modelId}`);
      }
      const estimated = estimateModelCredit(row, meta);
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
    credit: creditComplete ? roundCredit(credit) : null,
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

    const settled = await Promise.all(requests.map((req) => fetchJson(req.url, key, proxyOptions)));
    const byKey = {};
    let sawAuthError = false;
    let sawOk = false;
    requests.forEach((req, index) => {
      const result = settled[index];
      byKey[req.key] = result;
      if (result.status === 401 || result.status === 403) sawAuthError = true;
      if (result.ok) sawOk = true;
    });

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

      if (built.creditComplete) {
        const limit = details.limits[window];
        const used = built.credit;
        quotas[`Credits (${label})`] = {
          used,
          total: limit,
          resetAt: built.resetAt,
          remainingPercentage: limit > 0 ? Math.max(0, Math.round(((limit - used) / limit) * 100)) : 0,
          unlimited: false,
          budgetKind: "local-cap",
        };
      }
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan: "火山网关",
        message: "火山网关 usage API did not return usable day/week/month data.",
      };
    }

    const note = details.estimateComplete
      ? "Credits vs local caps (day 150 / week 450 / month 1000 by default). Token usage is in details — not a quota."
      : "Credit estimate incomplete — local remaining is hidden until daily tokens and date-effective coefficients are available. Open details for token counts.";

    return {
      plan: "火山网关",
      quotas,
      note,
      details,
    };
  } catch (error) {
    return { message: `火山网关 error: ${error.message}` };
  }
}
