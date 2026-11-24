import {
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_CN_PAY_BASE,
  applyCheckinOutcome,
  beijingDayKey,
  checkinDue,
  isUsableTraeDeviceId,
  newTraeDeviceId,
  pendingCheckinConnections,
  postTraeAccount,
  rollCheckinState,
  runAccountCheckin,
} from "open-sse/services/traeAccount.js";

// Daily check-in for active Trae CN accounts. Trae grants the reward once per
// device per Beijing day, so every account on this install shares one device id.
export const TRAE_CHECKIN_POLL_MS = 60 * 1000;
export const TRAE_CHECKIN_INITIAL_DELAY_MS = 20 * 1000;

const g = globalThis.__traeAutoCheckin ??= {
  started: false,
  timer: null,
  initial: null,
  running: false,
};

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  return phase === "phase-production-build"
    || phase === "phase-export"
    || phase === "phase-static"
    || process.env.NEXT_RUNTIME === "edge";
}

function isAuthHold(error) {
  const text = String(error?.message || "").toLowerCase();
  return text.includes("re-authorize") || text.includes("invalid or reused") || text.includes("unauthorized");
}

async function defaultDeps() {
  const db = await import("@/lib/localDb");
  const usageRoute = await import("@/app/api/usage/[connectionId]/route.js");
  const proxy = await import("@/lib/network/connectionProxy");
  return {
    getSettings: () => db.getSettings(),
    updateSettings: (updates) => db.updateSettings(updates),
    getConnections: () => db.getProviderConnections({ provider: "trae", isActive: true }),
    refresh: (connection, proxyOptions) => usageRoute.refreshAndUpdateCredentials(connection, false, proxyOptions),
    resolveProxy: (providerSpecificData) => proxy.resolveConnectionProxyConfig(providerSpecificData),
  };
}

async function proxyOptionsFor(connection, deps) {
  if (!deps.resolveProxy) return null;
  const config = await deps.resolveProxy(connection.providerSpecificData);
  return {
    connectionProxyEnabled: config?.connectionProxyEnabled === true,
    connectionProxyUrl: config?.connectionProxyUrl || "",
    connectionNoProxy: config?.connectionNoProxy || "",
    vercelRelayUrl: config?.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function defaultCheckin(connection, deviceId, proxyOptions) {
  const post = (kind, body) => {
    const path = kind === "claim" ? TRAE_CHECKIN_CLAIM_PATH : TRAE_CHECKIN_STATUS_PATH;
    return postTraeAccount(`${TRAE_CN_PAY_BASE}${path}`, connection.accessToken, body, {
      deviceId,
      origin: "https://www.trae.cn",
      proxyOptions,
      timeoutMs: 30000,
    });
  };
  return runAccountCheckin({ post });
}

function logOutcome(connectionId, outcome) {
  const id = String(connectionId || "").slice(0, 8);
  const message = outcome?.message ? `: ${String(outcome.message).slice(0, 120)}` : "";
  console.log(`[Trae Check-in] ${id} ${outcome?.status || "unknown"}${message}`);
}

export async function runTraeAutoCheckinTick(overrides = {}) {
  if (g.running) return;
  g.running = true;
  try {
    const deps = {
      now: () => Date.now(),
      checkin: defaultCheckin,
      ...overrides,
    };
    if (!deps.getSettings || !deps.updateSettings || !deps.getConnections) {
      Object.assign(deps, await defaultDeps(), overrides);
    }

    const settings = await deps.getSettings();
    const stored = settings?.traeAutoCheckin && typeof settings.traeAutoCheckin === "object"
      ? settings.traeAutoCheckin
      : {};
    let deviceId = stored.deviceId;
    const createdDevice = !isUsableTraeDeviceId(deviceId);
    if (createdDevice) deviceId = newTraeDeviceId();

    const now = deps.now();
    const day = beijingDayKey(now);
    let state = rollCheckinState(stored, day, deviceId);
    const rolled = createdDevice || stored.day !== day || stored.deviceId !== state.deviceId;
    if (rolled) await deps.updateSettings({ traeAutoCheckin: state });
    if (!checkinDue(state, now, day)) return;

    const pending = pendingCheckinConnections(await deps.getConnections(), state);
    if (pending.length === 0) return;

    for (const conn of pending) {
      if (state.deviceBlocked) break;
      const proxyOptions = await proxyOptionsFor(conn, deps);
      let connection = conn;
      if (deps.refresh) {
        try {
          const refreshed = await deps.refresh(conn, proxyOptions);
          if (refreshed?.connection) connection = refreshed.connection;
        } catch (error) {
          const status = isAuthHold(error) ? "auth-hold" : "failed";
          state = applyCheckinOutcome(state, {
            status,
            connectionId: conn.id,
            message: error?.message || "refresh failed",
          }, deps.now());
          logOutcome(conn.id, { status, message: state.lastMessage });
          if (status === "failed") break;
          continue;
        }
      }

      try {
        const outcome = await deps.checkin(connection, state.deviceId, proxyOptions);
        state = applyCheckinOutcome(state, { ...outcome, connectionId: conn.id }, deps.now());
        logOutcome(conn.id, outcome);
        if (outcome?.status === "busy" || outcome?.status === "failed" || outcome?.status === "device-already" || outcome?.status === "claimed") {
          break;
        }
      } catch (error) {
        state = applyCheckinOutcome(state, {
          status: "failed",
          connectionId: conn.id,
          message: error?.message || "check-in failed",
        }, deps.now());
        logOutcome(conn.id, { status: "failed", message: state.lastMessage });
        break;
      }
    }

    await deps.updateSettings({ traeAutoCheckin: state });
  } finally {
    g.running = false;
  }
}

export function startTraeAutoCheckin() {
  if (g.started) return false;
  if (process.env.DISABLE_TRAE_AUTO_CHECKIN === "1") return false;
  if (isNonServerRuntime()) return false;

  g.started = true;
  const safeTick = () => {
    runTraeAutoCheckinTick().catch((error) => {
      console.warn("[Trae Check-in] tick failed:", error?.message || error);
    });
  };
  g.initial = setTimeout(safeTick, TRAE_CHECKIN_INITIAL_DELAY_MS);
  g.timer = setInterval(safeTick, TRAE_CHECKIN_POLL_MS);
  if (g.initial.unref) g.initial.unref();
  if (g.timer.unref) g.timer.unref();
  console.log("[Trae Check-in] scheduler started");
  return true;
}

export function stopTraeAutoCheckin() {
  if (g.initial) clearTimeout(g.initial);
  if (g.timer) clearInterval(g.timer);
  g.initial = null;
  g.timer = null;
  g.started = false;
}
