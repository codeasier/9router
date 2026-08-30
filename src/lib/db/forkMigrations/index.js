import m001 from "./001-usage-history-api-key-index.js";

export const FORK_MIGRATIONS = [m001].sort((a, b) => a.version - b.version);

export function latestForkVersion() {
  return FORK_MIGRATIONS.length ? FORK_MIGRATIONS[FORK_MIGRATIONS.length - 1].version : 0;
}
