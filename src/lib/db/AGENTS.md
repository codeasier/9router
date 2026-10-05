# SQLite persistence

Inherits [repository guidance](../../../AGENTS.md). This subtree owns configuration, connections, keys, aliases, combos, usage history and request details. `../localDb.js` and `../usageDb.js` are compatibility exports; new consumers use `@/lib/db/index.js`.

## Storage and API boundaries

| Path | Responsibility |
|---|---|
| `index.js` | Public API barrel plus full configuration export/import |
| `repos/` | Per-entity SQL operations and usage aggregation |
| `helpers/jsonCol.js` | JSON column serialization/parsing |
| `driver.js`, `adapters/` | Runtime driver selection and common adapter operations |
| `../dataDir.js`, `paths.js` | Data-directory resolution and database/backup/legacy-file locations |
| `schema.js`, `migrate.js` | Declarative schema, startup migration and additive synchronization |
| `migrations/`, `forkMigrations/` | Independent official and fork migration registries |
| `backup.js` | Pre-schema/legacy import backups and retention |

The resolved data directory contains `db/data.sqlite` and `db/backups/`. Defaults are `~/.9router` on macOS/Linux and `%APPDATA%/9router` (with a home/AppData fallback) on Windows. An explicit `DATA_DIR` can fall back when permissions prevent directory creation; Windows rejects Unix-style absolute paths. Resolution occurs at module import time.

Usage is also SQLite-backed: `repos/usageRepo.js` reads/writes `usageHistory` and daily aggregates, and `getRecentLogs` derives lines from usage rows. `appendRequestLog` is a compatibility no-op. `db.json`, `usage.json`, `disabledModels.json` and `request-details.json` under `DATA_DIR` are legacy migration inputs, not active JSON stores. Older architecture/CLAUDE guidance describing usage outside `DATA_DIR` does not match this implementation.

## Driver selection and parity

- Bun tries `bun:sqlite`, then `sql.js`; it skips both Node native paths.
- Node tries `better-sqlite3`, then built-in `node:sqlite` when available on Node ≥22.5, then `sql.js`. `driver.js` deliberately skips `better-sqlite3` on Node ≥24.
- Preserve `run`, `get`, `all`, `exec`, synchronous `transaction` and cleanup semantics across adapters. Transaction callbacks must complete synchronously; do not pass an async callback to a wrapper that commits immediately after it returns.
- `sql.js` is an in-memory database with debounced disk export and explicit flush/close behavior. It needs its WASM asset at runtime; native adapters have different persistence/checkpoint behavior. Do not assume identical concurrent multi-process behavior.
- `global._dbAdapter` retains the adapter and initialization promise across Next hot reload. `getAdapterSync()` requires prior asynchronous initialization. Tests changing `DATA_DIR` must reset that singleton and module state before importing/initializing.

## Migration lifecycle

`getAdapter()` creates directories and selects a driver, then calls `runMigrationOnce`. Startup prunes backups, checks stored versions, runs official/fork chains, synchronizes additive schema changes and optionally imports legacy JSON.

Keep version namespaces distinct:

| Contract | Declarative version | Migration metadata/registry |
|---|---|---|
| Official | `SCHEMA_VERSION` / `backupSchemaVersion` | `schemaVersion`, `migrations/index.js` |
| Fork | `FORK_SCHEMA_VERSION` / `forkBackupSchemaVersion` | `forkSchemaVersion`, `forkMigrations/index.js` |

Fork-only schema changes must not consume official version numbers. Update `TABLES` and the appropriate declarative version; add a registered, monotonically versioned migration for data conversion or destructive changes. Additive synchronization does not implement drop/rename/type conversion. Preserve rejection of unsupported newer schemas and physical-fingerprint checks used to recognize historical mixed fork metadata.

Legacy JSON import is conditional on a fresh database, readable legacy data and absence of `db/.migrated-from-json`. Source JSON is retained and backed up. Connection/node/proxy/key/combo imports assert row counts and roll back on mismatch. Preserve that failure behavior rather than silently dropping rows; the marker is written only after a successful import.

`importDb` transactionally replaces supported configuration entities rather than merging them. It preserves the Codex reset-credit attempt ledger when the payload omits that property, and replaces it when explicitly present. Usage/request-detail tables are outside this configuration export/import payload. Preserve these distinctions when changing backup/API behavior.

## Focused verification

Follow [test setup](../../../tests/AGENTS.md). From `tests/`:

```bash
npx vitest run unit/db-driver-chain.test.js unit/db-migration-chain.test.js
npx vitest run unit/codex-reset-credit-attempts-db.test.js
```

Tests must use temporary data directories, close adapters and restore environment/global state. Check driver-specific paths when changing adapter semantics; a Node-only run does not establish Bun parity. Schema/API changes also need matching repository functions, barrel/shim exports and endpoint consumers; credentials and full DB exports must retain existing sanitization at the response boundary.
