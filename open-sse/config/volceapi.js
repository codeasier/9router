// Unified 火山网关 root for this fork. Connection-level baseUrl is out of scope
// (see codeasier/9router#19). All chat/usage/models paths are derived from here
// so `/v1` is never doubled.
export const VOLCEAPI_API_ROOT = "https://st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com/v1";

export const VOLCEAPI_WINDOWS = ["today", "week", "month"];

// Local configured credit caps — not upstream quota, balance, or auto-disable.
export const VOLCEAPI_DEFAULT_LIMITS = Object.freeze({
  today: 150,
  week: 450,
  month: 1000,
});

export const VOLCEAPI_TIMEZONE = "Asia/Shanghai";
export const VOLCEAPI_CREDIT_PER_MILLION = 1_000_000;

export const VOLCEAPI_WINDOW_LABELS = Object.freeze({
  today: "today",
  week: "week",
  month: "month",
});

// kimi-k3 on this gateway rejects any temperature other than 1 (issue #20).
export const VOLCEAPI_KIMI_K3_MODEL = "kimi-k3";

export const VOLCEAPI_REQUEST_OVERRIDES = Object.freeze([
  Object.freeze({
    models: Object.freeze([VOLCEAPI_KIMI_K3_MODEL]),
    set: Object.freeze({ temperature: 1 }),
  }),
]);
