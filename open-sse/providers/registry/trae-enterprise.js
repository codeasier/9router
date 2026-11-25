import { TRAE_CN_MODELS, TRAE_OAUTH_ENTERPRISE, traeRegistryEntry } from "./traeShared.js";

// Trae enterprise tenant pool. Login opens the enterprise console. www.trae.cn
// only signs in a personal account. Chat and token exchange stay on this host.
export default traeRegistryEntry({
  id: "trae-enterprise",
  alias: "tre",
  aliases: ["trae-ent"],
  name: "Trae (Enterprise)",
  color: "#7C3AED",
  textIcon: "TE",
  website: "https://console.enterprise.trae.cn",
  oauth: TRAE_OAUTH_ENTERPRISE,
  models: TRAE_CN_MODELS,
});
