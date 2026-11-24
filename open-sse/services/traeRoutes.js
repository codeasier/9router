// Client-safe Trae gateway constants. The dashboard registry imports this
// file. Do not import traeSolo.js or proxyFetch.js from here: those pull
// Node built-ins into the browser bundle.

export const TRAE_CHAT_PATH = "/api/agent/v3/llm_utils_chat";

export const TRAE_ROUTES = {
  trae: {
    id: "trae",
    region: "cn",
    enterprise: false,
    chatBase: "https://trae-api-cn.mchost.guru",
  },
  "trae-global": {
    id: "trae-global",
    region: "ai",
    enterprise: false,
    chatBase: "https://coresg-normal.trae.ai",
  },
  "trae-enterprise": {
    id: "trae-enterprise",
    region: "cn",
    enterprise: true,
    chatBase: "https://console.enterprise.trae.cn",
  },
};
