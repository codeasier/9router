import { TRAE_GLOBAL_MODELS, TRAE_OAUTH_GLOBAL, traeRegistryEntry } from "./traeShared.js";

// Trae international. Login and token exchange stay on trae.ai.
export default traeRegistryEntry({
  id: "trae-global",
  alias: "trg",
  aliases: ["trae-intl", "trae-ai"],
  name: "Trae (Global)",
  color: "#2563EB",
  textIcon: "TG",
  website: "https://www.trae.ai",
  oauth: TRAE_OAUTH_GLOBAL,
  models: TRAE_GLOBAL_MODELS,
});
