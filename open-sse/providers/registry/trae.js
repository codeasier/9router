import { TRAE_CN_MODELS, TRAE_OAUTH_CN, traeRegistryEntry } from "./traeShared.js";

// Trae CN personal pool. Chat bills the signed-in account's own credits.
export default traeRegistryEntry({
  id: "trae",
  alias: "tcn",
  aliases: ["marscode"],
  name: "Trae",
  color: "#FF6A00",
  textIcon: "TC",
  website: "https://www.trae.cn",
  oauth: TRAE_OAUTH_CN,
  models: TRAE_CN_MODELS,
});
