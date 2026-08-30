// GET /v1/usage — per-API-key usage introspection (issue #5).
//
// Auth: Bearer or x-api-key. Required for BOTH remote and loopback requests
// (intentionally stricter than sibling /v1 routes that let loopback skip
// auth). The route runs after dashboardGuard already accepted the request,
// so we re-extract the key and re-validate to enforce the self-service
// semantics.
//
// Inputs:
//   start      RFC 3339 timestamp, inclusive lower bound (default: now - 7d)
//   end        RFC 3339 timestamp, exclusive upper bound (default: now)
//   timezone   IANA tz name, used for `byDay` bucketing (default: server tz)
//
// Hard limits:
//   * window must be <= USAGE_QUERY_LIMITS.MAX_DAYS days
//   * both bounds must be in the past (no future queries)
//
// Errors use a stable { error: { code, message } } envelope.

import {
  getApiKeyByKey,
  getUsageForApiKey,
  USAGE_QUERY_LIMITS,
} from "@/lib/localDb";
import {
  checkRateLimit,
  getCachedUsage,
  setCachedUsage,
  withConcurrencyGate,
  isConcurrencyGateTimeout,
  USAGE_API_LIMITS,
} from "@/sse/services/usageApiGuard.js";

const DEFAULT_WINDOW_DAYS = 7;

function jsonError(status, code, message, extraHeaders = {}) {
  return Response.json(
    { error: { code, message } },
    { status, headers: extraHeaders }
  );
}

function jsonOk(body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

// Headers we accept for the self-service key. Same shape as the rest of the
// /v1 surface. Notably excludes x-goog-api-key and ?key= — those are
// upstream-LLM conventions and we don't want them minted into usage
// requests.
function extractBearerOrHeaderKey(request) {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const k = auth.slice(7).trim();
    if (k) return k;
  }
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey?.trim()) return xApiKey.trim();
  return null;
}

// Parse + validate a single timestamp param. We accept ISO 8601 with offset
// (RFC 3339). Plain date "YYYY-MM-DD" is upgraded to start-of-day UTC; this
// is a small ergonomic allowance that matches how dashboards typically
// accept day buckets.
function parseTimeParam(raw, { allowDateOnly = false } = {}) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let ms;
  if (allowDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    ms = Date.parse(`${trimmed}T00:00:00Z`);
  } else {
    ms = Date.parse(trimmed);
  }
  if (Number.isNaN(ms)) return null;
  return ms;
}

// Validate IANA tz via Intl. Falls back to undefined so the response echoes
// the actual value we ended up using (server local tz is computed downstream
// in the repo layer).
function resolveTimezone(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const tz = raw.trim();
  if (!tz) return undefined;
  try {
    // Probe formatting in the target tz — throws RangeError for invalid tz.
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return null;
  }
}

function defaultWindow(nowMs) {
  return {
    startMs: nowMs - DEFAULT_WINDOW_DAYS * 86400000,
    endMs: nowMs,
  };
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "authorization, x-api-key, content-type",
    },
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const now = Date.now();

  // 1. Auth — must be present + active. Loopback requests are NOT exempt
  // here; usage is self-service, so anonymous callers get 401 regardless
  // of where they connect from.
  const rawKey = extractBearerOrHeaderKey(request);
  if (!rawKey) {
    return jsonError(401, "UNAUTHORIZED", "API key required");
  }
  const apiKeyRow = await getApiKeyByKey(rawKey);
  if (!apiKeyRow || apiKeyRow.isActive !== true) {
    return jsonError(401, "INVALID_API_KEY", "Invalid API key");
  }

  // 2. Rate limit — per-key sliding window. Reject before doing any work.
  const rl = checkRateLimit(apiKeyRow.id, now);
  if (!rl.ok) {
    return jsonError(429, "RATE_LIMITED", "Too many requests", {
      "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)),
    });
  }

  // 3. Parse + validate params.
  const startRaw = params.get("start");
  const endRaw = params.get("end");
  const tzRaw = params.get("timezone");

  let startMs;
  let endMs;
  if (!startRaw && !endRaw) {
    const def = defaultWindow(now);
    startMs = def.startMs;
    endMs = def.endMs;
  } else {
    startMs = parseTimeParam(startRaw, { allowDateOnly: true });
    endMs = parseTimeParam(endRaw, { allowDateOnly: true });
    if (startMs == null || endMs == null) {
      return jsonError(400, "INVALID_PERIOD", "start/end must be RFC 3339 timestamps");
    }
  }

  if (!(startMs < endMs)) {
    return jsonError(400, "INVALID_PERIOD", "start must be earlier than end");
  }
  if (endMs > now + 60_000) {
    // 60s grace for client/server clock skew; queries anchored in the
    // future always return empty but we want to reject explicitly so the
    // mistake is visible.
    return jsonError(400, "INVALID_PERIOD", "end must not be in the future");
  }

  const windowDays = (endMs - startMs) / 86400000;
  if (windowDays > USAGE_QUERY_LIMITS.MAX_DAYS) {
    return jsonError(
      400,
      "PERIOD_TOO_LARGE",
      `window must be <= ${USAGE_QUERY_LIMITS.MAX_DAYS} days`
    );
  }

  let timeZone = resolveTimezone(tzRaw);
  if (tzRaw && timeZone === null) {
    return jsonError(400, "INVALID_PERIOD", "invalid timezone");
  }
  if (!timeZone) {
    // Server-local tz. Compute via Intl on the server so the bucket math
    // matches the dashboard "today" semantics users already see.
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      timeZone = "UTC";
    }
  }

  // 4. Cache lookup — full hit short-circuits the SQL roundtrip.
  const cached = getCachedUsage(apiKeyRow.id, startMs, endMs, timeZone, now);
  if (cached) {
    return jsonOk(cached, { "x-cache": "HIT" });
  }

  // 5. Concurrency-gated DB aggregation. The gate protects SQLite from
  // being slammed by parallel /v1/usage storms; unrelated traffic is
  // unaffected.
  let body;
  try {
    body = await withConcurrencyGate(() =>
      getUsageForApiKey({
        apiKey: apiKeyRow.key,
        startMs,
        endMs,
        timeZone,
      })
    );
  } catch (err) {
    if (isConcurrencyGateTimeout(err)) {
      return jsonError(503, "RATE_LIMITED", "server busy, retry shortly", {
        "retry-after": "1",
      });
    }
    console.error("[usageApi] aggregation failed:", err);
    return jsonError(500, "INTERNAL_ERROR", "failed to compute usage");
  }

  const responsePayload = {
    scope: "recorded_usage",
    coverage: ["chat"], // see note below
    apiKey: {
      id: apiKeyRow.id,
      name: apiKeyRow.name || null,
    },
    period: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      timezone: timeZone,
      days: Math.round((endMs - startMs) / 86400000),
    },
    total: body.total,
    byModel: body.byModel,
    byDay: body.byDay,
    truncated: body.truncated || false,
    currency: "USD",
    limits: {
      maxDays: USAGE_QUERY_LIMITS.MAX_DAYS,
      ratePerMinute: USAGE_API_LIMITS.RATE_LIMIT_MAX,
      cacheTtlSeconds: Math.floor(USAGE_API_LIMITS.CACHE_TTL_MS / 1000),
    },
  };

  setCachedUsage(apiKeyRow.id, startMs, endMs, timeZone, responsePayload);

  // Echo the resolved limits in the response so clients can self-throttle
  // without needing a separate docs roundtrip. status only — never echo the
  // raw API key, fingerprint, or any identifier beyond the public id+name.
  return jsonOk(responsePayload, { "x-cache": "MISS" });
}