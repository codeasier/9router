import { TRAE_CHAT_PATH, TRAE_ROUTES } from "../../services/traeRoutes.js";

// Login and token exchange follow the site that issued the account.
// api.marscode.com tells the browser to open www.trae.ai, so CN cannot use it.
const TRAE_OAUTH_COMMON = {
  clientId: "ono9krqynydwx5",
  clientSecret: "-",
  platform: "trae",
  pollInterval: 1500,
  refresh: { encoding: "json" },
};

export const TRAE_OAUTH_CN = {
  ...TRAE_OAUTH_COMMON,
  loginGuidanceUrl: "https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
  tokenUrl: "https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
  exchangeTokenUrl: "https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
  refreshUrl: "https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
  userInfoUrl: "https://api.trae.cn/cloudide/api/v3/trae/GetUserInfo",
};

export const TRAE_OAUTH_GLOBAL = {
  ...TRAE_OAUTH_COMMON,
  loginGuidanceUrl: "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
  tokenUrl: "https://api.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken",
  exchangeTokenUrl: "https://api.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken",
  refreshUrl: "https://api.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken",
  userInfoUrl: "https://api.trae.ai/cloudide/api/v3/trae/GetUserInfo",
};

const CN_MODELS = [
  { id: "glm-5.2", name: "GLM-5.2" },
  { id: "glm-5.3", name: "GLM-5.3" },
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
  { id: "kimi-k2.5", name: "Kimi-K2.5" },
  { id: "minimax-m3", name: "MiniMax-M3" },
];

const GLOBAL_MODELS = [
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash-solo", name: "Gemini 3 Flash" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "minimax-m3", name: "MiniMax-M3" },
  { id: "kimi-k2.5", name: "Kimi-K2.5" },
];

export function traeRegistryEntry({ id, alias, aliases, name, color, textIcon, website, models, oauth }) {
  const route = TRAE_ROUTES[id];
  return {
    id,
    alias,
    uiAlias: alias,
    aliases,
    category: "oauth",
    authType: "oauth",
    hasOAuth: true,
    authModes: ["oauth"],
    // The quota page only lists providers that declare this flag.
    features: { usage: true },
    // The picker, provider page and /v1/models replace these rows with the
    // account's live directory. Any id the account can call is accepted.
    // The rows below are only the fallback when that fetch returns nothing.
    passthroughModels: true,
    display: {
      name,
      icon: "bolt",
      color,
      textIcon,
      website,
      notice: { signupUrl: website },
    },
    transport: {
      baseUrl: `${route.chatBase}${TRAE_CHAT_PATH}`,
      format: "openai",
      auth: {
        combined: true,
        header: "Authorization",
        scheme: "Cloud-IDE-JWT",
      },
    },
    oauth,
    models,
  };
}

export const TRAE_CN_MODELS = CN_MODELS;
export const TRAE_GLOBAL_MODELS = GLOBAL_MODELS;
