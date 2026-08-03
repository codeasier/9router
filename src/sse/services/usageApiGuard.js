// Per-API-key rate limiter + bounded in-memory response cache for the
// /v1/usage endpoint (issue #5). Two layers:
//
//   1. RateLimiter  — sliding-window count per apiKeyId (UUID, stable).
//   2. ResponseCache — TTL'd Map, keyed by apiKeyId + (startMs, endMs, tz).
//
// Both live on `global.*` so they survive Next.js dev hot-reload. They
// intentionally do not persist — losing state on restart is acceptable and
// avoids needing yet another disk-backed store.

const RATE_LIMIT_MAX = 60;             // requests
const RATE_LIMIT_WINDOW_MS = 60_000;   // per minute
const CACHE_TTL_MS = 120_000;          // 2 minutes (configurable per-call)
const CACHE_MAX_ENTRIES = 1024;
const MAX_CONCURRENT_QUERIES = 8;
const CONCURRENT_QUEUE_TIMEOUT_MS = 1000;

if (!global._usageApiState) {
  global._usageApiState = {
    rate: new Map(), // apiKeyId -> { count, windowStart }
    cache: new Map(), // key -> { expiresAt, value }
    cacheOrder: [],   // insertion order for LRU eviction
    inflight: 0,
    waiters: [],
  };
}
const state = global._usageApiState;

// ─── Rate limiter ────────────────────────────────────────────────────────
// Returns { ok, retryAfterMs } — callers translate ok=false into 429 with a
// Retry-After header.
export function checkRateLimit(apiKeyId, now = Date.now()) {
  if (!apiKeyId) return { ok: false, retryAfterMs: RATE_LIMIT_WINDOW_MS };
  const entry = state.rate.get(apiKeyId);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    state.rate.set(apiKeyId, { count: 1, windowStart: now });
    return { ok: true, retryAfterMs: 0 };
  }
  if (entry.count < RATE_LIMIT_MAX) {
    entry.count += 1;
    return { ok: true, retryAfterMs: 0 };
  }
  return {
    ok: false,
    retryAfterMs: Math.max(1, entry.windowStart + RATE_LIMIT_WINDOW_MS - now),
  };
}

// Test/observability helper — never invoked in the hot path.
export function _resetUsageApiState() {
  state.rate.clear();
  state.cache.clear();
  state.cacheOrder.length = 0;
  state.inflight = 0;
  state.waiters.length = 0;
}

// ─── Response cache ──────────────────────────────────────────────────────
// Cache key is a stable fingerprint of the request — apiKeyId (not raw key)
// is safe to use because it's already a UUID. We include the time window so
// shifting windows naturally miss.
function makeCacheKey(apiKeyId, startMs, endMs, timeZone) {
  return `${apiKeyId}|${startMs}|${endMs}|${timeZone}`;
}

export function getCachedUsage(apiKeyId, startMs, endMs, timeZone, now = Date.now()) {
  const key = makeCacheKey(apiKeyId, startMs, endMs, timeZone);
  const entry = state.cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    state.cache.delete(key);
    const idx = state.cacheOrder.indexOf(key);
    if (idx >= 0) state.cacheOrder.splice(idx, 1);
    return null;
  }
  // LRU touch — move key to end of insertion order.
  const idx = state.cacheOrder.indexOf(key);
  if (idx >= 0) state.cacheOrder.splice(idx, 1);
  state.cacheOrder.push(key);
  return entry.value;
}

export function setCachedUsage(apiKeyId, startMs, endMs, timeZone, value, ttlMs = CACHE_TTL_MS) {
  const key = makeCacheKey(apiKeyId, startMs, endMs, timeZone);
  if (state.cache.has(key)) {
    const idx = state.cacheOrder.indexOf(key);
    if (idx >= 0) state.cacheOrder.splice(idx, 1);
  }
  state.cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  state.cacheOrder.push(key);
  // Bound memory — drop oldest until under cap.
  while (state.cacheOrder.length > CACHE_MAX_ENTRIES) {
    const oldest = state.cacheOrder.shift();
    state.cache.delete(oldest);
  }
}

// ─── Global concurrency semaphore ────────────────────────────────────────
// Guards the underlying SQLite adapter from concurrent /v1/usage storms.
// Other LLM traffic is unaffected — this only throttles queries tagged as
// expensive aggregations.
export async function withConcurrencyGate(fn) {
  if (state.inflight < MAX_CONCURRENT_QUERIES) {
    state.inflight += 1;
    try {
      return await fn();
    } finally {
      state.inflight -= 1;
      releaseWaiter();
    }
  }
  // Wait our turn, but bail if the queue head has been starving too long.
  return new Promise((resolve, reject) => {
    const enqueuedAt = Date.now();
    const waiter = async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    state.waiters.push({ run: waiter, enqueuedAt });
    // Safety: if we wait past the queue timeout, drop out with 503.
    setTimeout(() => {
      const idx = state.waiters.findIndex((w) => w.enqueuedAt === enqueuedAt);
      if (idx >= 0) {
        state.waiters.splice(idx, 1);
        reject(new ConcurrencyGateTimeout());
      }
    }, CONCURRENT_QUEUE_TIMEOUT_MS).unref?.();
  });
}

class ConcurrencyGateTimeout extends Error {
  constructor() {
    super("usage query concurrency gate timeout");
    this.name = "ConcurrencyGateTimeout";
  }
}

export function isConcurrencyGateTimeout(err) {
  return err instanceof ConcurrencyGateTimeout;
}

function releaseWaiter() {
  while (state.waiters.length && state.inflight < MAX_CONCURRENT_QUERIES) {
    const next = state.waiters.shift();
    state.inflight += 1;
    // Fire-and-forget — the waiter itself runs fn() and resolves its own promise.
    Promise.resolve()
      .then(next.run)
      .catch(() => {})
      .finally(() => {
        state.inflight -= 1;
        releaseWaiter();
      });
  }
}

// Exposed so tests can assert configuration without reaching into globals.
export const USAGE_API_LIMITS = Object.freeze({
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  MAX_CONCURRENT_QUERIES,
  CONCURRENT_QUEUE_TIMEOUT_MS,
});