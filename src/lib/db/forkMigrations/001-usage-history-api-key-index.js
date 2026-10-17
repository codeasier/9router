// Fork-local migration #1. This used to occupy official migration #2.
export default {
  version: 1,
  name: "usage-history-api-key-index",
  up(db) {
    // The table itself is created by the additive schema sync (which also
    // carries this index in TABLES.usageHistory). Only index an existing
    // table — minimal fixtures and partial databases may not have it yet.
    const hasTable = db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usageHistory'`);
    if (!hasTable) return;
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_uh_apiKey_ts ON usageHistory(apiKey, timestamp DESC)"
    );
  },
};
