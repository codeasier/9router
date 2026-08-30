// Fork-local migration #1. This used to occupy official migration #2.
export default {
  version: 1,
  name: "usage-history-api-key-index",
  up(db) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_uh_apiKey_ts ON usageHistory(apiKey, timestamp DESC)"
    );
  },
};
