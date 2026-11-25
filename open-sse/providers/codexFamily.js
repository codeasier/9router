// Two Codex OAuth lanes share the ChatGPT transport, catalog, and prices.
// `codex-backup` is a separate connection pool and API-key budget key so a
// second ChatGPT account can be metered without touching `codex`.

export function isCodexFamilyProvider(provider) {
  return provider === "codex" || provider === "codex-backup";
}

// Registry alias used for model lookup. Accepts the stored id or the public alias.
export function codexCatalogAlias(provider) {
  if (provider === "codex" || provider === "cx") return "cx";
  if (provider === "codex-backup" || provider === "cx-new") return "cx-new";
  return null;
}
