import crypto from "crypto";
import { TRAE_VERSION_CODE } from "open-sse/services/traeSolo.js";
import { TRAE_CONFIG } from "../constants/oauth.js";
import { extractJsonPath } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Trae (ByteDance marscode) OAuth helpers
// ───────────────────────────────────────────────────────────────────────────

// Per-login device context. No IDE access in 9router, so use stable defaults.
function buildTraeDeviceContext() {
  return {
    plugin_version: TRAE_CONFIG.defaultPluginVersion,
    machine_id: crypto.randomUUID(),
    device_id: TRAE_CONFIG.defaultDeviceId,
    x_device_brand: "unknown",
    x_device_type: "unknown",
    x_os_version: "unknown",
    x_env: "",
    x_app_version: TRAE_CONFIG.defaultAppVersion,
    x_app_type: TRAE_CONFIG.defaultAppType,
  };
}

const TRAE_CN_LOGIN_GUIDANCE_URLS = [
  "https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
  "https://api.marscode.cn/cloudide/api/v3/trae/GetLoginGuidance",
];
const TRAE_GLOBAL_LOGIN_GUIDANCE_URLS = [
  "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
  "https://www.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
];
const TRAE_CN_API_ORIGINS = [
  "https://api.trae.cn",
  "https://api.marscode.cn",
];
const TRAE_GLOBAL_API_ORIGINS = [
  "https://api.trae.ai",
  "https://api.marscode.com",
  "https://www.trae.ai",
];

// POST GetLoginGuidance → { Result: { LoginHost } }
// api.marscode.com answers with www.trae.ai, so CN must not share that list.
async function fetchTraeLoginGuidance(loginTraceId, urls) {
  const body = JSON.stringify({ loginTraceID: loginTraceId, login_trace_id: loginTraceId });
  let lastErr = "no successful response";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": TRAE_CONFIG.userAgent,
        },
        body,
      });
      if (!res.ok) { lastErr = `${url} HTTP ${res.status}`; continue; }
      const data = await res.json();
      const loginHost = extractJsonPath(data, [
        ["Result", "LoginHost"], ["Result", "loginHost"], ["Result", "LoginURL"],
        ["result", "loginHost"], ["data", "Result", "LoginHost"], ["data", "loginHost"],
        ["LoginHost"], ["loginHost"],
      ]);
      if (loginHost) return loginHost;
      lastErr = `${url} missing LoginHost`;
    } catch (e) { lastErr = `${url} ${e.message}`; }
  }
  throw new Error(`Trae GetLoginGuidance failed: ${lastErr}`);
}

// Build the browser verification URL the user opens to sign in.
function buildTraeVerificationUrl(loginHost, loginTraceId, callbackUrl, ctx) {
  const url = new URL(loginHost.startsWith("http") ? loginHost : `https://${loginHost.replace(/^\/+/, "")}`);
  url.pathname = TRAE_CONFIG.authorizationPath;
  const p = new URLSearchParams();
  p.set("login_version", "1");
  p.set("auth_from", "trae");
  p.set("login_channel", "native_ide");
  p.set("plugin_version", ctx.plugin_version);
  p.set("auth_type", "local");
  p.set("client_id", TRAE_CONFIG.clientId);
  p.set("redirect", "0");
  p.set("login_trace_id", loginTraceId);
  p.set("auth_callback_url", callbackUrl);
  p.set("machine_id", ctx.machine_id);
  p.set("device_id", ctx.device_id);
  p.set("x_device_id", ctx.device_id);
  p.set("x_machine_id", ctx.machine_id);
  p.set("x_device_brand", ctx.x_device_brand);
  p.set("x_device_type", ctx.x_device_type);
  p.set("x_os_version", ctx.x_os_version);
  p.set("x_env", ctx.x_env);
  p.set("x_app_version", ctx.x_app_version);
  p.set("x_app_type", ctx.x_app_type);
  url.search = p.toString();
  return url.toString();
}

// Parse the Trae OAuth callback (full URL, query string, or hash).
// CN redirects to /authorize?refreshToken=...&host=...&userJwt=...
// loginHost is not used for the token request (SSRF guard); it is optional.
export function parseTraeCallback(raw) {
  const params = traeCallbackParams(raw);
  const pick = (keys) => {
    for (const key of keys) {
      const value = params.get(key);
      if (value && String(value).trim()) return String(value).trim();
    }
    return null;
  };
  const err = pick(["error", "error_code", "errorCode"]);
  if (err) {
    const desc = pick(["error_description", "error_desc", "message"]);
    throw new Error(desc ? `Trae auth failed: ${err} (${desc})` : `Trae auth failed: ${err}`);
  }
  const refreshToken = pick(["refreshToken", "refresh_token", "RefreshToken", "data"]);
  const cloudideToken = pick(["userJwt", "user_jwt", "x-cloudide-token", "xCloudideToken", "accessToken", "access_token", "token"]);
  if (!refreshToken && !cloudideToken) throw new Error("Trae callback missing refreshToken");
  return {
    refreshToken,
    loginHost: pick(["loginHost", "login_host", "LoginHost", "host", "consoleHost"]),
    cloudideToken,
  };
}

function traeCallbackParams(raw) {
  const text = String(raw || "").trim();
  let search = "";
  let hash = "";
  const candidate = /^https?:\/\//i.test(text)
    ? text
    : `http://127.0.0.1/authorize?${text.replace(/^\?/, "").replace(/^#/, "")}`;
  try {
    const url = new URL(candidate);
    search = url.search.replace(/^\?/, "");
    hash = url.hash.replace(/^#/, "");
  } catch {
    const queryAt = text.indexOf("?");
    const hashAt = text.indexOf("#");
    if (queryAt >= 0) search = text.slice(queryAt + 1, hashAt > queryAt ? hashAt : undefined);
    if (hashAt >= 0) hash = text.slice(hashAt + 1);
  }
  const params = new URLSearchParams(search);
  const hashParams = new URLSearchParams(hash);
  for (const [key, value] of hashParams) {
    if (!params.get(key)) params.set(key, value);
  }
  return params;
}

// CN returns the Cloud-IDE token as Result itself (a string). The international
// endpoint returns Result.AccessToken. The website stores that Result on the
// callback as userJwt.
export function traeAccessTokenFromExchange(data) {
  const result = data?.Result ?? data?.result;
  if (typeof result === "string" && result.trim()) {
    return { accessToken: result.trim(), refreshToken: null, expiresAt: null };
  }
  const record = result && typeof result === "object" && !Array.isArray(result) ? result : null;
  if (!record) return null;
  const accessToken = [
    record.AccessToken, record.accessToken, record.access_token,
    record.Token, record.token, record.Jwt, record.jwt, record.UserJwt, record.userJwt,
  ].find((value) => typeof value === "string" && value.trim());
  if (!accessToken) return null;
  return {
    accessToken: accessToken.trim(),
    refreshToken: record.RefreshToken || record.refreshToken || record.refresh_token || null,
    expiresAt: record.ExpiresAt || record.expiresAt || record.ExpiredAt || record.expiredAt || null,
  };
}

function traeExchangeError(data) {
  return extractJsonPath(data, [
    ["ResponseMetadata", "Error", "Message"],
    ["ResponseMetadata", "error", "message"],
    ["message"], ["msg"], ["error"], ["Result", "Message"],
  ]);
}

function usableCloudIdeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token.length < 40 || token === "[object Object]") return null;
  return token;
}

function isTraeCallbackInput(text) {
  return /[?#&=]/.test(text) && /(?:refreshToken|refresh_token|userJwt)=/i.test(text);
}

// Allowed API origins for ExchangeToken/GetUserInfo — hardcoded HTTPS allowlist only.
// loginHost from the callback is intentionally NOT honored (SSRF guard: a callback
// attacker could otherwise point this at internal hosts/cloud metadata).
// POST ExchangeToken {ClientID, RefreshToken, ClientSecret, UserID} → {Result:{AccessToken,RefreshToken,ExpiresAt}}
async function fetchTraeExchangeToken(refreshToken, cloudideToken, origins) {
  const body = JSON.stringify({
    ClientID: TRAE_CONFIG.clientId,
    RefreshToken: refreshToken,
    ClientSecret: TRAE_CONFIG.clientSecret,
    UserID: "",
  });
  let lastErr = "no successful response";
  for (const origin of origins) {
    const url = `${origin.replace(/\/$/, "")}${TRAE_CONFIG.exchangeTokenPath}`;
    try {
      const headers = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": TRAE_CONFIG.userAgent,
      };
      if (cloudideToken && !usableCloudIdeToken(cloudideToken)) cloudideToken = null;
      if (cloudideToken) headers["x-cloudide-token"] = cloudideToken;
      const res = await fetch(url, { method: "POST", headers, body });
      const text = await res.text();
      if (!res.ok) { lastErr = `${url} HTTP ${res.status}`; continue; }
      let data; try { data = JSON.parse(text); } catch { lastErr = `${url} invalid JSON`; continue; }
      const parsed = traeAccessTokenFromExchange(data);
      if (!parsed) {
        const result = data?.Result ?? data?.result;
        const kind = result == null ? "absent" : Array.isArray(result) ? "array" : typeof result;
        const keys = result && typeof result === "object" && !Array.isArray(result)
          ? Object.keys(result).slice(0, 8).join(",")
          : "";
        lastErr = `${url} ${traeExchangeError(data) || `missing AccessToken (Result ${kind}${keys ? ` ${keys}` : ""})`}`;
        continue;
      }
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken || refreshToken,
        expiresIn: null, // ExchangeToken returns ExpiresAt (absolute), converted below
        expiresAt: parsed.expiresAt,
      };
    } catch (e) { lastErr = `${url} ${e.message}`; }
  }
  throw new Error(`Trae ExchangeToken failed: ${lastErr}`);
}

// POST GetUserInfo with x-cloudide-token → identity fields used by SOLO common_params.
async function fetchTraeUserInfo(accessToken, origins) {
  for (const origin of origins) {
    const url = `${origin.replace(/\/$/, "")}${TRAE_CONFIG.getUserInfoPath}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": TRAE_CONFIG.userAgent,
          "x-cloudide-token": accessToken,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) continue;
      const data = await res.json();
      return {
        email: extractJsonPath(data, [
          ["Result", "NonPlainTextEmail"], ["Result", "Email"], ["Result", "email"],
          ["email"], ["data", "email"],
        ]),
        name: extractJsonPath(data, [
          ["Result", "ScreenName"], ["Result", "Nickname"], ["Result", "Name"],
          ["result", "nickname"], ["nickname"], ["name"],
        ]),
        aiRegion: extractJsonPath(data, [["Result", "AIRegion"], ["Result", "aiRegion"], ["aiRegion"]]),
        region: extractJsonPath(data, [["Result", "Region"], ["Result", "region"], ["region"]]),
        tenant: extractJsonPath(data, [["Result", "TenantID"], ["Result", "tenantId"], ["tenantId"]]),
        userId: extractJsonPath(data, [["Result", "UserID"], ["Result", "userId"], ["userId"]]),
      };
    } catch { /* try next origin */ }
  }
  return { email: null, name: null };
}

// Map AIRegion (e.g. "SG", "US") → SOLO scope used in common_params.
function traeScopeForRegion(aiRegion) {
  const r = (aiRegion || "").toLowerCase();
  if (r === "sg" || r.includes("singapore")) return "marscode-sg";
  if (r === "cn" || r.includes("cn") || r.includes("china")) return "marscode-cn";
  return "marscode-us";
}

// Browser OAuth shared by Trae CN, international and enterprise.
// GetLoginGuidance → verification URL → local callback → ExchangeToken → GetUserInfo.
// The provider id, not the user-info region, chooses which chat gateway is billed.
function createTraeOAuthProvider({ chatRoute, userRegion, loginGuidanceUrls, apiOrigins }) {
  const pendingDevices = new Map();
  return {
    config: TRAE_CONFIG,
    loginGuidanceUrls,
    apiOrigins,
    flowType: "authorization_code",
    callbackPath: TRAE_CONFIG.callbackPath,
    prepareConfig: async (config) => {
      const loginTraceID = crypto.randomUUID();
      const loginHost = await fetchTraeLoginGuidance(loginTraceID, loginGuidanceUrls);
      return { ...config, loginTraceID, loginHost };
    },
    buildAuthUrl: (config, redirectUri, state) => {
      const ctx = buildTraeDeviceContext();
      const traceId = config.loginTraceID || state;
      if (traceId) pendingDevices.set(traceId, ctx);
      return buildTraeVerificationUrl(config.loginHost, traceId, redirectUri, ctx);
    },
    exchangeToken: async (config, code) => {
      const device = (config?.loginTraceID && pendingDevices.get(config.loginTraceID)) || buildTraeDeviceContext();
      if (config?.loginTraceID) pendingDevices.delete(config.loginTraceID);
      const trimmed = String(code || "").trim();
      if (isTraeCallbackInput(trimmed)) {
        const parsed = parseTraeCallback(trimmed);
        const direct = usableCloudIdeToken(parsed.cloudideToken);
        try {
          if (!parsed.refreshToken) {
            if (!direct) throw new Error("Trae callback missing refreshToken");
            return {
              accessToken: direct,
              refreshToken: null,
              expiresIn: TRAE_CONFIG.tokenLifetimeDays * 24 * 60 * 60,
              _authMethod: "callback",
              _device: device,
            };
          }
          return {
            ...(await fetchTraeExchangeToken(parsed.refreshToken, direct, apiOrigins)),
            _authMethod: "oauth",
            _device: device,
          };
        } catch (error) {
          if (!direct) throw error;
          return {
            accessToken: direct,
            refreshToken: parsed.refreshToken,
            expiresIn: TRAE_CONFIG.tokenLifetimeDays * 24 * 60 * 60,
            _authMethod: "callback",
            _device: device,
          };
        }
      }
      // Paste-token mode: raw Cloud-IDE-JWT (no refresh exchange)
      const clean = trimmed.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, "");
      return {
        accessToken: clean,
        refreshToken: null,
        expiresIn: TRAE_CONFIG.tokenLifetimeDays * 24 * 60 * 60,
        _authMethod: "imported",
        _device: device,
      };
    },
    postExchange: async (tokens) => {
      const userInfo = await fetchTraeUserInfo(tokens.accessToken, apiOrigins);
      return { userInfo };
    },
    mapTokens: (tokens, extra) => {
      const expiresIn = tokens.expiresIn
        || (tokens.expiresAt ? Math.max(60, Number(tokens.expiresAt) - Math.floor(Date.now() / 1000)) : TRAE_CONFIG.tokenLifetimeDays * 24 * 60 * 60);
      const ui = extra?.userInfo || {};
      const device = tokens._device || buildTraeDeviceContext();
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn,
        email: ui.email || undefined,
        displayName: ui.name || undefined,
        providerSpecificData: {
          authMethod: tokens._authMethod || "oauth",
          chatRoute,
          userRegion,
          aiRegion: ui.aiRegion || userRegion,
          region: ui.region || userRegion,
          tenant: ui.tenant || "marscode",
          userId: ui.userId || "",
          scope: traeScopeForRegion(userRegion),
          machineId: device.machine_id,
          deviceId: device.device_id,
          appVersion: device.x_app_version || TRAE_CONFIG.defaultAppVersion,
          versionCode: TRAE_VERSION_CODE,
        },
      };
    },
  };
}

const cnLogin = {
  loginGuidanceUrls: TRAE_CN_LOGIN_GUIDANCE_URLS,
  apiOrigins: TRAE_CN_API_ORIGINS,
};
const trae = createTraeOAuthProvider({ chatRoute: "consumer", userRegion: "CN", ...cnLogin });
export const traeGlobal = createTraeOAuthProvider({
  chatRoute: "consumer",
  userRegion: "SG",
  loginGuidanceUrls: TRAE_GLOBAL_LOGIN_GUIDANCE_URLS,
  apiOrigins: TRAE_GLOBAL_API_ORIGINS,
});
export const traeEnterprise = createTraeOAuthProvider({ chatRoute: "enterprise", userRegion: "CN", ...cnLogin });

export default trae;
