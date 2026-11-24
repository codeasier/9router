import crypto from "crypto";
import { fetchWithTimeout } from "./usage/shared.js";

// Trae CN credits and the daily check-in. The pay/ug routes are the ones the
// Trae usage page calls with the same Cloud-IDE-JWT the chat channel uses.
// International accounts are subscriptions (no credit packs, no check-in).
// The enterprise tenant pool is not on any of these routes.

export const TRAE_CN_PAY_BASE = "https://api.trae.cn";
export const TRAE_GLOBAL_PAY_BASE = "https://growsg-normal.trae.ai";
export const TRAE_CN_ENTITLEMENT_PATH = "/trae/api/v2/pay/web_user_ent_usage";
export const TRAE_GLOBAL_PAY_STATUS_PATH = "/trae/api/v1/pay/ide_user_pay_status";
export const TRAE_CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
export const TRAE_CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";

export const TRAE_CHECKIN_BUSY_CODE = 9074;
export const TRAE_CHECKIN_DEVICE_CODE = 9095;
export const TRAE_CHECKIN_BAD_ORDER_CODE = 9004;

const CHECKIN_BACKOFF_CAP_MS = 30 * 60 * 1000;

export const TRAE_ENTERPRISE_USAGE_MESSAGE =
  "Trae Enterprise bills the tenant pool. That balance is only available in the Trae enterprise console, so this card does not show personal credits as the tenant balance.";

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function roundCredit(value) {
  return Math.round(value * 10000) / 10000;
}

// Beijing has no daylight-saving shift, so UTC+8 is the calendar Trae uses.
export function beijingDayKey(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// "0" and an empty header are "no device". Check-in then answers 9004 and grants nothing.
export function isUsableTraeDeviceId(value) {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return id !== "" && id !== "0";
}

// One id per 9router install, kept as a string so a 19-digit value is not rounded.
export function newTraeDeviceId() {
  let id = String(crypto.randomInt(1, 10));
  for (let i = 0; i < 18; i += 1) id += String(crypto.randomInt(0, 10));
  return id;
}

export function epochToMs(value) {
  const n = asNumber(value);
  if (n === undefined || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

export function unwrapTraePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const nested = payload.data ?? payload.Data;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return payload;
  const topHas = payload.user_entitlement_pack_list
    || payload.usage_summary
    || payload.checked_in !== undefined
    || payload.user_pay_identity !== undefined
    || payload.is_credits_billing !== undefined;
  if (topHas) return payload;
  return { ...payload, ...nested };
}

function packCredits(pack) {
  const base = pack?.entitlement_base_info;
  const quota = base?.quota;
  const productExtra = base?.product_extra?.package_extra?.quota;
  const limit = asNumber(productExtra?.credits_limit) ?? asNumber(quota?.credits_limit);
  const consumed = asNumber(pack?.usage?.credits_amount);
  return {
    displayDesc: typeof pack?.display_desc === "string" ? pack.display_desc : "",
    availableEndpoint: asNumber(base?.available_endpoint),
    creditsLimit: limit,
    consumedCredits: consumed,
    endTimeMs: epochToMs(base?.end_time),
  };
}

export function parseEntitlementSnapshot(payload) {
  const body = unwrapTraePayload(payload);
  const summaryRaw = body.usage_summary && typeof body.usage_summary === "object" ? body.usage_summary : {};
  const packs = Array.isArray(body.user_entitlement_pack_list) ? body.user_entitlement_pack_list : [];
  return {
    summary: {
      totalAmount: asNumber(summaryRaw.total_amount) ?? 0,
      consumedAmount: asNumber(summaryRaw.consumed_amount) ?? 0,
    },
    packs: packs.filter((pack) => pack && typeof pack === "object").map(packCredits),
  };
}

function earliestExpiry(packs, nowMs) {
  let earliest = 0;
  for (const pack of packs) {
    const limit = pack.creditsLimit ?? 0;
    const consumed = pack.consumedCredits ?? 0;
    if (limit <= 0 || limit - consumed <= 0) continue;
    if (!pack.endTimeMs || pack.endTimeMs <= nowMs) continue;
    if (!earliest || pack.endTimeMs < earliest) earliest = pack.endTimeMs;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

function bucketQuota(packs, endpoint, nowMs) {
  let used = 0;
  let total = 0;
  const matched = [];
  for (const pack of packs) {
    if (pack.availableEndpoint !== endpoint) continue;
    const limit = pack.creditsLimit ?? 0;
    if (limit <= 0) continue;
    const consumed = Math.max(0, pack.consumedCredits ?? 0);
    used += consumed;
    total += limit;
    matched.push(pack);
  }
  if (total <= 0) return null;
  return {
    used: roundCredit(used),
    total: roundCredit(total),
    resetAt: earliestExpiry(matched, nowMs),
    recurring: false,
  };
}

// `usage.credits_amount` is credits already consumed, not the remaining balance.
export function entitlementQuotas(snapshot, nowMs = Date.now()) {
  const packs = Array.isArray(snapshot?.packs) ? snapshot.packs : [];
  const quotas = {};
  const total = snapshot?.summary?.totalAmount ?? 0;
  const consumed = snapshot?.summary?.consumedAmount ?? 0;
  if (total > 0) {
    quotas.Credits = {
      used: roundCredit(consumed),
      total: roundCredit(total),
      resetAt: earliestExpiry(packs, nowMs),
      recurring: false,
    };
  }
  const general = bucketQuota(packs, 0, nowMs);
  const work = bucketQuota(packs, 1, nowMs);
  if (general) quotas.General = general;
  if (work) quotas.Work = work;
  return quotas;
}

export function parsePayStatus(payload) {
  const body = unwrapTraePayload(payload);
  const trial = body.trial_status && typeof body.trial_status === "object" ? body.trial_status : {};
  const identity = typeof body.user_pay_identity_str === "string" ? body.user_pay_identity_str.trim() : "";
  return {
    payIdentity: asNumber(body.user_pay_identity),
    payIdentityStr: identity,
    hasPackage: body.has_package === true,
    inTrial: trial.is_in_trial === true,
    trialEndTimeMs: epochToMs(trial.trial_end_time),
  };
}

export function payStatusToUsage(status) {
  const name = status?.payIdentityStr
    || (status?.payIdentity === 0 ? "Free" : "Subscription");
  const parts = [`International plan: ${name}.`];
  if (status?.inTrial && status.trialEndTimeMs) {
    parts.push(`Trial ends ${new Date(status.trialEndTimeMs).toISOString().slice(0, 10)}.`);
  } else if (status?.hasPackage) {
    parts.push("An active package is on the account.");
  } else {
    parts.push("International Trae does not report a credit balance.");
  }
  return { plan: name, message: parts.join(" ") };
}

export function parseCheckinStatus(payload, httpStatus = 200) {
  const body = unwrapTraePayload(payload);
  const code = asNumber(body.code);
  return {
    httpStatus,
    code: code ?? (httpStatus >= 400 ? httpStatus : 0),
    checkedIn: body.checked_in === true,
    didCheckedIn: body.did_checked_in === true,
    enabled: body.enable !== false,
    credits: asNumber(body.credits) ?? 0,
    extraCredits: asNumber(body.extra_credits) ?? 0,
    message: typeof body.message === "string" ? body.message.slice(0, 200) : "",
  };
}

export function parseCheckinClaim(payload, httpStatus = 200) {
  const body = unwrapTraePayload(payload);
  const code = asNumber(body.code);
  return {
    httpStatus,
    code: code ?? (httpStatus >= 400 ? httpStatus : 0),
    message: typeof body.message === "string" ? body.message.slice(0, 200) : "",
  };
}

export function decideCheckin(status) {
  if (!status) return "failed";
  if (status.code === TRAE_CHECKIN_BUSY_CODE) return "busy";
  if (status.httpStatus >= 400 || status.code) return "failed";
  if (status.enabled === false) return "disabled";
  if (status.checkedIn) return "already";
  if (status.didCheckedIn) return "device-already";
  return "claim";
}

export function checkinNote(status) {
  if (!status || status.enabled === false) return "Daily check-in is off for this account.";
  const reward = (status.credits || 0) + (status.extraCredits || 0);
  const rewardText = reward > 0 ? ` (+${reward})` : "";
  if (status.checkedIn) return `Checked in today${rewardText}.`;
  if (status.didCheckedIn) return "This device already checked in today on another account.";
  return reward > 0 ? `Daily check-in is still open${rewardText}.` : "Daily check-in is still open.";
}

function claimOutcome(parsed) {
  if (parsed.code === 0 && parsed.httpStatus < 400) return { status: "claimed", message: parsed.message || "success" };
  if (parsed.code === TRAE_CHECKIN_DEVICE_CODE) return { status: "device-already", message: parsed.message };
  if (parsed.code === TRAE_CHECKIN_BUSY_CODE) return { status: "busy", message: parsed.message };
  if (parsed.code === TRAE_CHECKIN_BAD_ORDER_CODE) {
    return { status: "failed", message: parsed.message || "Trae check-in rejected the device id." };
  }
  return { status: "failed", message: parsed.message || `Trae check-in was refused (${parsed.code}).` };
}

// Status and claim both accept req_source. 1 is the Trae IDE client this login uses.
// 9074 is also the temporary crowd response, so a single fallback to 2 is enough.
export async function runAccountCheckin({ post }) {
  let statusRes = await post("status", { req_source: 1 });
  let status = parseCheckinStatus(statusRes?.body, statusRes?.httpStatus ?? 0);
  if (status.code === TRAE_CHECKIN_BUSY_CODE) {
    statusRes = await post("status", { req_source: 2 });
    status = parseCheckinStatus(statusRes?.body, statusRes?.httpStatus ?? 0);
  }
  const decision = decideCheckin(status);
  if (decision !== "claim") return { status: decision, message: status.message || "" };

  let claimRes = await post("claim", { req_source: 1 });
  let claim = parseCheckinClaim(claimRes?.body, claimRes?.httpStatus ?? 0);
  if (claim.code === TRAE_CHECKIN_BUSY_CODE) {
    claimRes = await post("claim", { req_source: 2 });
    claim = parseCheckinClaim(claimRes?.body, claimRes?.httpStatus ?? 0);
  }
  return claimOutcome(claim);
}

export async function postTraeAccount(url, token, body, { deviceId, origin, proxyOptions = null, timeoutMs = 15000 } = {}) {
  const headers = {
    Authorization: `Cloud-IDE-JWT ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Trae/3.5.54",
    Origin: origin,
    Referer: `${origin}/`,
  };
  if (isUsableTraeDeviceId(deviceId)) headers["x-device-id"] = deviceId.trim();
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  }, timeoutMs, proxyOptions);
  const text = await response.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 200) };
    }
  }
  return { httpStatus: response.status, body: json };
}

export async function getTraeAccountUsage(connection) {
  const provider = connection?.provider;
  const token = connection?.accessToken || connection?.apiKey;
  if (!token) return { message: "Trae credential not available." };
  if (provider === "trae-enterprise") {
    return { plan: "Enterprise", message: TRAE_ENTERPRISE_USAGE_MESSAGE };
  }

  const proxyOptions = connection.proxyOptions || null;
  try {
    if (provider === "trae-global") {
      const res = await postTraeAccount(`${TRAE_GLOBAL_PAY_BASE}${TRAE_GLOBAL_PAY_STATUS_PATH}`, token, {}, {
        origin: "https://www.trae.ai",
        proxyOptions,
      });
      if (res.httpStatus === 401 || res.httpStatus === 403) {
        return { message: "Trae International credential invalid or expired." };
      }
      if (res.httpStatus >= 400) {
        return { message: `Trae International subscription status failed (${res.httpStatus}).` };
      }
      return payStatusToUsage(parsePayStatus(res.body));
    }

    const res = await postTraeAccount(`${TRAE_CN_PAY_BASE}${TRAE_CN_ENTITLEMENT_PATH}`, token, { require_usage: true }, {
      origin: "https://www.trae.cn",
      proxyOptions,
    });
    if (res.httpStatus === 401 || res.httpStatus === 403) {
      return { message: "Trae credential invalid or expired." };
    }
    if (res.httpStatus >= 400) {
      return { message: `Trae credit status failed (${res.httpStatus}).` };
    }

    const snapshot = parseEntitlementSnapshot(res.body);
    const quotas = entitlementQuotas(snapshot);
    let note = "";
    try {
      const deviceId = connection?.providerSpecificData?.deviceId;
      const statusRes = await postTraeAccount(`${TRAE_CN_PAY_BASE}${TRAE_CHECKIN_STATUS_PATH}`, token, { req_source: 1 }, {
        origin: "https://www.trae.cn",
        deviceId,
        proxyOptions,
      });
      if (statusRes.httpStatus < 400) {
        const status = parseCheckinStatus(statusRes.body, statusRes.httpStatus);
        if (!isUsableTraeDeviceId(deviceId)) status.didCheckedIn = false;
        if (!status.code) note = checkinNote(status);
      }
    } catch {
      // The balance is still useful when the check-in status read fails.
    }

    if (Object.keys(quotas).length === 0) {
      return { plan: "Trae", message: "Trae connected. No credit balance reported.", ...(note ? { note } : {}) };
    }
    return { plan: "Credits", quotas, ...(note ? { note } : {}) };
  } catch (error) {
    return { message: `Trae credit status failed: ${error.message}` };
  }
}

export function rollCheckinState(stored, day, deviceId) {
  const base = stored && typeof stored === "object" ? stored : {};
  const sameDay = base.day === day;
  const strings = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string" && id) : []);
  return {
    day,
    deviceId: deviceId || (typeof base.deviceId === "string" ? base.deviceId : ""),
    done: sameDay ? strings(base.done) : [],
    skip: sameDay ? strings(base.skip) : [],
    deviceBlocked: sameDay ? base.deviceBlocked === true : false,
    failures: sameDay && Number.isFinite(base.failures) ? base.failures : 0,
    retryAt: sameDay && Number.isFinite(base.retryAt) ? base.retryAt : 0,
    lastResult: sameDay && typeof base.lastResult === "string" ? base.lastResult : "",
    lastMessage: sameDay && typeof base.lastMessage === "string" ? base.lastMessage : "",
  };
}

export function checkinDue(state, now, day) {
  if (!state || state.day !== day) return true;
  if (state.deviceBlocked) return false;
  if (Number(state.retryAt) > now) return false;
  return true;
}

export function pendingCheckinConnections(connections, state) {
  const skip = new Set([...(state?.done || []), ...(state?.skip || [])]);
  return (connections || []).filter((conn) => {
    if (!conn || conn.provider !== "trae") return false;
    if (conn.isActive === false) return false;
    if (!conn.accessToken) return false;
    return !skip.has(conn.id);
  });
}

export function applyCheckinOutcome(state, outcome, now) {
  const done = new Set(state.done || []);
  const skip = new Set(state.skip || []);
  const status = outcome?.status;
  const id = outcome?.connectionId;
  if (id && (status === "already" || status === "claimed")) done.add(id);
  if (id && (status === "auth-hold" || status === "disabled")) skip.add(id);

  const deviceBlocked = state.deviceBlocked === true || status === "claimed" || status === "device-already";
  const failed = status === "failed" || status === "busy";
  const failures = failed ? (state.failures || 0) + 1 : (status === "claimed" || status === "already" ? 0 : (state.failures || 0));
  let retryAt = state.retryAt || 0;
  if (failed) retryAt = now + Math.min(CHECKIN_BACKOFF_CAP_MS, 30_000 * 2 ** Math.min(failures, 6));
  else if (status === "claimed" || status === "already" || status === "device-already") retryAt = 0;

  return {
    ...state,
    done: [...done],
    skip: [...skip],
    deviceBlocked,
    failures,
    retryAt,
    lastResult: status || state.lastResult || "",
    lastMessage: typeof outcome?.message === "string" ? outcome.message.slice(0, 200) : "",
  };
}
