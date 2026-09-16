import { VOLCEAPI_API_ROOT } from "../../config/volceapi.js";

const API_ROOT = VOLCEAPI_API_ROOT;

export default {
  id: "volceapi",
  priority: 215,
  alias: "volceapi",
  aliases: [
    "volce",
  ],
  uiAlias: "volceapi",
  display: {
    name: "火山网关",
    icon: "hub",
    color: "#E63E2E",
    textIcon: "火",
    website: API_ROOT,
    notice: {
      text: "Volcengine API Gateway LLM proxy. Personal Bearer key. Catalog varies by deployment — add custom models and optionally declare chat / responses / messages per model.",
      apiKeyUrl: API_ROOT,
    },
  },
  category: "apikey",
  transport: {
    baseUrl: `${API_ROOT}/chat/completions`,
    validateUrl: `${API_ROOT}/models`,
    usage: {
      url: API_ROOT,
    },
  },
  // Gateway key-auth is Bearer on every protocol endpoint (issue #19). Do not
  // copy opencode-go's x-api-key Claude row. anthropic-version is still sent on
  // /messages so Anthropic-shaped bodies keep the required header.
  transports: [
    {
      format: "openai",
      baseUrl: `${API_ROOT}/chat/completions`,
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: `${API_ROOT}/messages`,
      auth: { combined: true, header: "Authorization", scheme: "bearer", anthropicVersion: true },
    },
    {
      format: "openai-responses",
      baseUrl: `${API_ROOT}/responses`,
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
  ],
  // Deployment catalogs differ; custom models + passthrough are the source of truth.
  models: [],
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
