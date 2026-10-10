import { getProxyPoolById } from "@/models";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Fields copied onto credentials.providerSpecificData after pool resolution.
 * Chat and other executors read this object to build proxyOptions — omitting a
 * field here silently drops the setting (strictProxy used to be lost this way).
 */
export function toCredentialProxyFields(resolvedProxy = {}) {
  return {
    connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
    connectionProxyUrl: resolvedProxy.connectionProxyUrl,
    connectionNoProxy: resolvedProxy.connectionNoProxy,
    connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
    vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
    strictProxy: resolvedProxy.strictProxy === true,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * A bound pool must be available; errors never fall back to another transport.
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  const proxyPoolIdRaw = normalizeString(
    providerSpecificData?.proxyPoolId
  );

  // "__none__" means explicitly disabled
  const proxyPoolId =
    proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

  const legacy = normalizeLegacyProxy(providerSpecificData);

  /**
   * -----------------------------
   * Proxy Pool Resolution
   * -----------------------------
   */
  if (proxyPoolId) {
    let proxyPool;
    try {
      proxyPool = await getProxyPoolById(proxyPoolId);
    } catch {
      // A failed lookup cannot prove that the connection is unbound. Never
      // substitute legacy, global or direct transport for its selected pool.
      throw new Error("Bound proxy pool lookup failed");
    }

    const proxyUrl = normalizeString(proxyPool?.proxyUrl);
    const noProxy = normalizeString(proxyPool?.noProxy);

    const isValidPool =
      proxyPool &&
      proxyPool.isActive === true &&
      proxyUrl;

    if (!isValidPool) {
      throw new Error("Bound proxy pool is unavailable (missing, inactive or empty URL)");
    }

    /**
     * Vercel/Cloudflare relay proxies use base URL rewriting
     * instead of HTTP_PROXY environment variables.
     */
    if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
      return {
        source: proxyPool.type,

        proxyPoolId,
        proxyPool,

        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: noProxy,

        strictProxy: proxyPool.strictProxy === true,

        vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
      };
    }

    /**
     * Standard proxy pool
     */
    return {
      source: "pool",

      proxyPoolId,
      proxyPool,

      connectionProxyEnabled: true,
      connectionProxyUrl: proxyUrl,
      connectionNoProxy: noProxy,

      strictProxy: proxyPool.strictProxy === true,
    };
  }

  /**
   * -----------------------------
   * Legacy Proxy Fallback
   * -----------------------------
   */
  if (
    legacy.connectionProxyEnabled &&
    legacy.connectionProxyUrl
  ) {
    return {
      source: "legacy",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      ...legacy,
    };
  }

  /**
   * -----------------------------
   * No Proxy Config
   * -----------------------------
   */
  return {
    source: "none",

    proxyPoolId: proxyPoolId || null,
    proxyPool: null,

    ...legacy,
  };
}
