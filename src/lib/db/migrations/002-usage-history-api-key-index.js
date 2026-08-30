// Adds a composite index on usageHistory to make per-API-key range queries
// (used by the new /v1/usage endpoint) cheap. Existing per-key history still
// falls back to the older idx_uh_ts scan if the new index hasn't been
// applied yet, so this migration is purely additive.
const migration = {
  version: 2,
  name: "usage-history-api-key-index",
  up(db) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_uh_apiKey_ts ON usageHistory(apiKey, timestamp DESC)"
    );
  },
};

export default migration;