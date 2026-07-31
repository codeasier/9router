import "open-sse/index.js";

import {
  createCodexResetCreditAttempt,
  getActiveCodexResetCreditAttempt,
  getLatestCodexResetCreditAttempt,
  getProviderConnections,
  getSettings,
  updateCodexResetCreditAttempt,
} from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import {
  consumeCodexRateLimitResetCredit,
  getCodexRateLimitResetCredits,
} from "open-sse/services/usage.js";
import { getCodexAccountIdentity } from "open-sse/services/usage/codex.js";
import {
  findExpiringCodexResetCredit,
  MAX_CODEX_RESET_AUTO_USE_MINUTES,
  normalizeCodexResetAutoUseMinutes,
} from "./codexResetCreditUtils.js";

export {
  findExpiringCodexResetCredit,
  MAX_CODEX_RESET_AUTO_USE_MINUTES,
  normalizeCodexResetAutoUseMinutes,
};
export const CODEX_RESET_AUTO_USE_POLL_MS = 60000;
export const CODEX_RESET_AUTO_USE_CONCURRENCY = 3;

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
const ACTIVE_ATTEMPT_STATES = new Set(["planned", "dispatching", "unknown", "auth_required"]);
const CONFIRMED_CREDIT_STATES = new Set(["redeemed", "consumed", "used", "applied"]);

const g = (global.__codexResetCreditService ??= {
  locks: new Map(),
  interval: null,
  running: false,
});

function getCreditFingerprint(credit) {
  return credit?.id || `${credit?.grantedAt || "unknown"}|${credit?.expiresAt || "unknown"}`;
}

function findCreditByFingerprint(inventory, fingerprint) {
  return (inventory?.credits || []).find((credit) => getCreditFingerprint(credit) === fingerprint) || null;
}

function findManualCredit(inventory) {
  return (inventory?.credits || [])
    .filter((credit) => String(credit?.status || "").toLowerCase() === "available")
    .sort((a, b) => (new Date(a.expiresAt).getTime() || Infinity) - (new Date(b.expiresAt).getTime() || Infinity))[0] || null;
}

function isAuthExpired(value) {
  if (value?.status === 401 || value?.status === 403) return true;
  const text = [value?.message, value?.code, value?.raw?.detail, value?.raw?.error]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((pattern) => text.includes(pattern));
}

function buildProxyOptions(config) {
  return {
    connectionProxyEnabled: config?.connectionProxyEnabled === true,
    connectionProxyUrl: config?.connectionProxyUrl || "",
    connectionNoProxy: config?.connectionNoProxy || "",
    vercelRelayUrl: config?.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function withAccountLock(accountIdentity, action, state = g) {
  const previous = state.locks.get(accountIdentity) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  state.locks.set(accountIdentity, current);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (state.locks.get(accountIdentity) === current) state.locks.delete(accountIdentity);
  }
}

function createDefaultDeps() {
  return {
    createAttempt: createCodexResetCreditAttempt,
    getActiveAttempt: getActiveCodexResetCreditAttempt,
    getLatestAttempt: getLatestCodexResetCreditAttempt,
    updateAttempt: updateCodexResetCreditAttempt,
    getProviderConnections,
    getSettings,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    getResetCredits: getCodexRateLimitResetCredits,
    consumeResetCredit: consumeCodexRateLimitResetCredit,
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}

async function prepareConnection(connection, deps) {
  const proxyConfig = await deps.resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyConfig);
  if (connection.authType !== "oauth") return { connection, proxyOptions };
  const refreshed = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
  return { connection: refreshed.connection, proxyOptions };
}

async function fetchInventory(connection, proxyOptions, deps) {
  try {
    const inventory = await deps.getResetCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
    return { connection, inventory };
  } catch (error) {
    if (connection.authType !== "oauth" || !connection.refreshToken || !isAuthExpired(error)) throw error;
    const refreshed = await deps.refreshAndUpdateCredentials(connection, true, proxyOptions);
    const next = refreshed.connection;
    const inventory = await deps.getResetCredits(next.accessToken, proxyOptions, next.providerSpecificData);
    return { connection: next, inventory };
  }
}

async function finishAttempt(attempt, status, result, deps) {
  await deps.updateAttempt(attempt.id, {
    status,
    result,
    updatedAt: new Date(deps.now()).toISOString(),
  });
  return { attempt: { ...attempt, status, result }, state: status, result };
}

async function reconcileAttempt(attempt, inventory, deps) {
  if (!attempt || !ACTIVE_ATTEMPT_STATES.has(attempt.status)) return null;
  const credit = findCreditByFingerprint(inventory, attempt.creditFingerprint);
  const creditStatus = String(credit?.status || "").toLowerCase();

  if (credit && CONFIRMED_CREDIT_STATES.has(creditStatus)) {
    return await finishAttempt(attempt, "confirmed", { reconciledFromCreditStatus: creditStatus }, deps);
  }
  if (!credit && inventory.availableCount < attempt.availableCountBefore) {
    return await finishAttempt(attempt, "confirmed", { reconciledFromAvailableCount: true }, deps);
  }
  if (!credit && attempt.creditExpiresAt && deps.now() >= new Date(attempt.creditExpiresAt).getTime()) {
    return await finishAttempt(attempt, "expired_unresolved", { reason: "credit_expired_before_outcome_was_known" }, deps);
  }
  if (credit && creditStatus !== "available") {
    if (creditStatus === "expired") {
      return await finishAttempt(attempt, "expired_unresolved", { reason: "credit_expired_before_outcome_was_known" }, deps);
    }
    return await finishAttempt(attempt, "unknown", { reason: `unrecognized_credit_status:${creditStatus || "missing"}` }, deps);
  }
  if (!credit) {
    return await finishAttempt(attempt, "unknown", { reason: "credit_missing_without_inventory_decrease" }, deps);
  }
  return { attempt, state: "retry_same_id" };
}

async function dispatchAttempt(attempt, connection, proxyOptions, deps) {
  await deps.updateAttempt(attempt.id, {
    connectionId: connection.id,
    status: "dispatching",
    updatedAt: new Date(deps.now()).toISOString(),
  });

  let result;
  try {
    result = await deps.consumeResetCredit(
      connection.accessToken,
      attempt.redeemRequestId,
      proxyOptions,
      connection.providerSpecificData,
    );
    if (isAuthExpired(result) && connection.authType === "oauth" && connection.refreshToken) {
      const refreshed = await deps.refreshAndUpdateCredentials(connection, true, proxyOptions);
      connection = refreshed.connection;
      result = await deps.consumeResetCredit(
        connection.accessToken,
        attempt.redeemRequestId,
        proxyOptions,
        connection.providerSpecificData,
      );
    }
  } catch (error) {
    return await finishAttempt(attempt, "unknown", { message: error.message }, deps);
  }

  if (result.ok) return await finishAttempt(attempt, "confirmed", result, deps);
  if (result.noCredit) return await finishAttempt(attempt, "no_credit", result, deps);
  if (isAuthExpired(result)) return await finishAttempt(attempt, "auth_required", result, deps);
  if (result.status >= 500) return await finishAttempt(attempt, "unknown", result, deps);
  return await finishAttempt(attempt, "rejected", result, deps);
}

export async function useCodexResetCredit(connection, options = {}, injectedDeps = null, state = g) {
  const deps = injectedDeps || createDefaultDeps();
  const auto = options.auto === true;
  const stableIdentity = getCodexAccountIdentity(connection?.providerSpecificData);
  if (auto && !stableIdentity) return { state: "unstable_identity", auto: true };
  const accountIdentity = stableIdentity || `connection:${connection.id}`;

  return await withAccountLock(accountIdentity, async () => {
    let prepared = await prepareConnection(connection, deps);
    let currentConnection = prepared.connection;
    const fetched = await fetchInventory(currentConnection, prepared.proxyOptions, deps);
    currentConnection = fetched.connection;
    const inventory = fetched.inventory;

    const active = await deps.getActiveAttempt(accountIdentity);
    if (active) {
      const reconciled = await reconcileAttempt(active, inventory, deps);
      if (reconciled?.state === "retry_same_id") {
        if (options.respectSetting === true) {
          const settings = await deps.getSettings();
          if (!normalizeCodexResetAutoUseMinutes(settings.codexResetCreditAutoUseMinutes)) {
            return { attempt: active, state: "disabled", auto: true };
          }
        }
        return await dispatchAttempt(active, currentConnection, prepared.proxyOptions, deps);
      }
      return reconciled;
    }

    const threshold = normalizeCodexResetAutoUseMinutes(options.thresholdMinutes);
    const credit = auto
      ? findExpiringCodexResetCredit(inventory, threshold, deps.now())
      : findManualCredit(inventory);
    if (!credit) return { state: auto ? "not_due" : "no_credit", auto };

    const creditFingerprint = getCreditFingerprint(credit);
    const latest = await deps.getLatestAttempt?.(accountIdentity, creditFingerprint);
    const fallbackIdentityCanAdvance = !credit.id
      && inventory.availableCount < latest?.availableCountBefore;
    if (latest?.status === "confirmed" && !fallbackIdentityCanAdvance) {
      return { attempt: latest, state: "already_consumed", auto };
    }
    if (options.respectSetting === true) {
      const settings = await deps.getSettings();
      if (!normalizeCodexResetAutoUseMinutes(settings.codexResetCreditAutoUseMinutes)) {
        return { state: "disabled", auto: true };
      }
    }

    const now = new Date(deps.now()).toISOString();
    const planned = {
      id: deps.randomUUID(),
      accountIdentity,
      connectionId: currentConnection.id,
      creditFingerprint,
      creditExpiresAt: credit.expiresAt || null,
      availableCountBefore: inventory.availableCount,
      redeemRequestId: deps.randomUUID(),
      status: "planned",
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    const attempt = await deps.createAttempt(planned);
    if (attempt.id !== planned.id) {
      const reconciled = await reconcileAttempt(attempt, inventory, deps);
      if (reconciled?.state !== "retry_same_id") return reconciled;
    }
    return await dispatchAttempt(attempt, currentConnection, prepared.proxyOptions, deps);
  }, state);
}

export async function getCodexResetCreditInventory(connection, injectedDeps = null, state = g) {
  const deps = injectedDeps || createDefaultDeps();
  const accountIdentity = getCodexAccountIdentity(connection?.providerSpecificData) || `connection:${connection.id}`;
  return await withAccountLock(accountIdentity, async () => {
    const prepared = await prepareConnection(connection, deps);
    const fetched = await fetchInventory(prepared.connection, prepared.proxyOptions, deps);
    return fetched.inventory;
  }, state);
}

export async function runCodexResetCreditAutoUseTick(injectedDeps = null, state = g) {
  const deps = injectedDeps || createDefaultDeps();
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();
    const thresholdMinutes = normalizeCodexResetAutoUseMinutes(settings.codexResetCreditAutoUseMinutes);
    if (!thresholdMinutes) return;

    const connections = await deps.getProviderConnections({ provider: "codex", isActive: true });
    const accounts = new Map();
    for (const connection of connections) {
      if (!["oauth", "access_token"].includes(connection.authType)) continue;
      const identity = getCodexAccountIdentity(connection.providerSpecificData);
      if (identity && !accounts.has(identity)) accounts.set(identity, connection);
    }
    const targets = [...accounts.values()];
    let nextIndex = 0;
    async function runWorker() {
      while (nextIndex < targets.length) {
        const connection = targets[nextIndex++];
        try {
          await useCodexResetCredit(connection, { auto: true, thresholdMinutes, respectSetting: true }, deps, state);
        } catch (error) {
          console.warn(`[Codex Reset Credits] ${connection.id}: ${error.message}`);
        }
      }
    }
    const workerCount = Math.min(CODEX_RESET_AUTO_USE_CONCURRENCY, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  } catch (error) {
    console.warn("[Codex Reset Credits] scheduler tick failed:", error.message);
  } finally {
    state.running = false;
  }
}

export function startCodexResetCreditAutoUse() {
  if (g.interval) return;
  runCodexResetCreditAutoUseTick().catch(() => {});
  g.interval = setInterval(() => { runCodexResetCreditAutoUseTick().catch(() => {}); }, CODEX_RESET_AUTO_USE_POLL_MS);
  if (g.interval.unref) g.interval.unref();
}

export function stopCodexResetCreditAutoUse() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
}

export function configureCodexResetCreditAutoUse(settings) {
  if (normalizeCodexResetAutoUseMinutes(settings?.codexResetCreditAutoUseMinutes)) startCodexResetCreditAutoUse();
  else stopCodexResetCreditAutoUse();
}
