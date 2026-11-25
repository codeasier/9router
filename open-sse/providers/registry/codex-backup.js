import codex from "./codex.js";

// Second OpenAI Codex lane. Models are published as cx-new/<id>. OAuth, usage
// endpoints, and model ids match `codex`, so pricing and quota math stay the
// same. Connections, refresh state, and API-key budgets stay on this id.
export default {
  ...codex,
  id: "codex-backup",
  priority: 31,
  alias: "cx-new",
  uiAlias: "cx-new",
  display: {
    ...codex.display,
    name: "OpenAI Codex (Backup)",
  },
};
