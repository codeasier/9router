import { TRAE_CN_MODELS, TRAE_OAUTH_CN, traeRegistryEntry } from "./traeShared.js";

// Trae enterprise tenant pool. OAuth is the same CN login, but every call stays
// on the tenant gateway and is never replayed against personal credits.
export default traeRegistryEntry({
  id: "trae-enterprise",
  alias: "tre",
  aliases: ["trae-ent"],
  name: "Trae (Enterprise)",
  color: "#7C3AED",
  textIcon: "TE",
  website: "https://www.trae.cn",
  oauth: TRAE_OAUTH_CN,
  models: TRAE_CN_MODELS,
});
