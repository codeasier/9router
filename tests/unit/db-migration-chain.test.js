// Verify official and fork migration namespaces against historical physical schemas.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let originalProcessListeners;
const originalDataDir = process.env.DATA_DIR;
const PROCESS_EVENTS = ["beforeExit", "SIGINT", "SIGTERM"];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-"));
  process.env.DATA_DIR = tempDir;
  originalProcessListeners = new Map(
    PROCESS_EVENTS.map((event) => [event, new Set(process.listeners(event))]),
  );
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  for (const event of PROCESS_EVENTS) {
    for (const listener of process.listeners(event)) {
      if (!originalProcessListeners.get(event).has(listener)) process.removeListener(event, listener);
    }
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function databaseFile() {
  return path.join(tempDir, "db", "data.sqlite");
}

function backupCount() {
  const backupDir = path.join(tempDir, "db", "backups");
  if (!fs.existsSync(backupDir)) return 0;
  return fs.readdirSync(backupDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

function expectBackups(count) {
  const backupDir = path.join(tempDir, "db", "backups");
  const entries = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  expect(entries).toHaveLength(count);
  for (const entry of entries) {
    expect(fs.existsSync(path.join(backupDir, entry.name, "data.sqlite"))).toBe(true);
  }
}

async function createTestAdapter(filePath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    return createSqlJsAdapter(filePath);
  }
  const db = new DatabaseSync(filePath);
  return {
    run(sql, params = []) { return db.prepare(sql).run(...params); },
    get(sql, params = []) { return db.prepare(sql).get(...params); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
    exec(sql) { return db.exec(sql); },
    transaction(fn) {
      const savepoint = `test_${Math.random().toString(36).slice(2)}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    },
    close() { db.close(); },
  };
}

async function createHistoricalDatabase(kind, { policyColumn = kind === "fork-v4" } = {}) {
  const dbDir = path.dirname(databaseFile());
  fs.mkdirSync(path.join(dbDir, "backups"), { recursive: true });
  const db = await createTestAdapter(databaseFile());
  const policySql = policyColumn ? ", policy TEXT" : "";

  db.exec(`
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    CREATE TABLE providerConnections (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL, name TEXT,
      email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX idx_pc_provider ON providerConnections(provider);
    CREATE INDEX idx_pc_provider_active ON providerConnections(provider, isActive);
    CREATE INDEX idx_pc_priority ON providerConnections(provider, priority);
    CREATE TABLE providerNodes (
      id TEXT PRIMARY KEY, type TEXT, name TEXT, data TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX idx_pn_type ON providerNodes(type);
    CREATE TABLE proxyPools (
      id TEXT PRIMARY KEY, isActive INTEGER DEFAULT 1, testStatus TEXT, data TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX idx_pp_active ON proxyPools(isActive);
    CREATE INDEX idx_pp_status ON proxyPools(testStatus);
    CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
      isActive INTEGER DEFAULT 1${policySql}, createdAt TEXT NOT NULL
    );
    CREATE INDEX idx_ak_key ON apiKeys(key);
    CREATE TABLE combos (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX idx_combo_name ON combos(name);
    CREATE TABLE kv (
      scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE INDEX idx_kv_scope ON kv(scope);
    CREATE TABLE usageHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT,
      model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT,
      promptTokens INTEGER DEFAULT 0, completionTokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0, status TEXT, tokens TEXT, meta TEXT
    );
    CREATE INDEX idx_uh_ts ON usageHistory(timestamp DESC);
    CREATE INDEX idx_uh_provider ON usageHistory(provider);
    CREATE INDEX idx_uh_model ON usageHistory(model);
    CREATE INDEX idx_uh_conn ON usageHistory(connectionId);
    CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE requestDetails (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, provider TEXT, model TEXT,
      connectionId TEXT, status TEXT, data TEXT NOT NULL
    );
    CREATE INDEX idx_rd_ts ON requestDetails(timestamp DESC);
    CREATE INDEX idx_rd_provider ON requestDetails(provider);
    CREATE INDEX idx_rd_model ON requestDetails(model);
    CREATE INDEX idx_rd_conn ON requestDetails(connectionId);
  `);
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ sentinel: kind })]);

  if (kind === "official-v1") {
    db.run(`INSERT INTO _meta(key, value) VALUES('schemaVersion', '1')`);
    db.run(`INSERT INTO _meta(key, value) VALUES('backupSchemaVersion', '1')`);
  } else {
    const backupVersion = kind === "fork-v3" ? 3 : 4;
    db.run(`INSERT INTO _meta(key, value) VALUES('schemaVersion', '2')`);
    db.run(`INSERT INTO _meta(key, value) VALUES('backupSchemaVersion', ?)`, [String(backupVersion)]);
    db.exec(`
      CREATE INDEX idx_uh_apiKey_ts ON usageHistory(apiKey, timestamp DESC);
      CREATE TABLE codexResetCreditAttempts (
        id TEXT PRIMARY KEY, accountIdentity TEXT NOT NULL, connectionId TEXT NOT NULL,
        creditFingerprint TEXT NOT NULL, creditExpiresAt TEXT,
        availableCountBefore INTEGER NOT NULL, redeemRequestId TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL, result TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX idx_cra_account
        ON codexResetCreditAttempts(accountIdentity, createdAt DESC);
      CREATE UNIQUE INDEX idx_cra_one_active_account
        ON codexResetCreditAttempts(accountIdentity)
        WHERE status IN ('planned', 'dispatching', 'unknown', 'auth_required');
    `);
  }

  db.close();
}

async function bootDatabase() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

async function restartDatabase(db) {
  db.close?.();
  delete global._dbAdapter;
  vi.resetModules();
  return bootDatabase();
}

function metadata(db) {
  return Object.fromEntries(db.all(`SELECT key, value FROM _meta`).map((row) => [row.key, row.value]));
}

function expectCurrentSchema(db, sentinel) {
  const meta = metadata(db);
  expect(meta.schemaVersion).toBe("1");
  expect(meta.forkSchemaVersion).toBe("1");
  expect(meta.backupSchemaVersion).toBe("1");
  expect(meta.forkBackupSchemaVersion).toBe("4");
  expect(JSON.parse(db.get(`SELECT data FROM settings WHERE id = 1`).data)).toEqual({ sentinel });
  expect(db.all(`PRAGMA table_info(apiKeys)`).map((column) => column.name)).toContain("policy");
  expect(db.all(`PRAGMA index_list(usageHistory)`).map((index) => index.name)).toContain("idx_uh_apiKey_ts");
  expect(db.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codexResetCreditAttempts'`,
  )?.name).toBe("codexResetCreditAttempts");
  expect(db.get(`PRAGMA integrity_check`).integrity_check).toBe("ok");
}

describe("Schema migrations", () => {
  it("creates a fresh DB with independent official and fork metadata", async () => {
    const db = await bootDatabase();
    const meta = metadata(db);
    expect(meta.schemaVersion).toBe("1");
    expect(meta.forkSchemaVersion).toBe("1");
    expect(meta.backupSchemaVersion).toBe("1");
    expect(meta.forkBackupSchemaVersion).toBe("4");
    expect(db.get(`PRAGMA integrity_check`).integrity_check).toBe("ok");
    expectBackups(0);
  });

  it.each([
    ["official-v1", false, 1],
    ["fork-v3", false, 1],
    ["fork-v4", true, 0],
  ])("upgrades %s physical schema and preserves metadata on restart", async (kind, policyColumn, backups) => {
    await createHistoricalDatabase(kind, { policyColumn });
    let db = await bootDatabase();
    expectCurrentSchema(db, kind);
    expectBackups(backups);

    db = await restartDatabase(db);
    expectCurrentSchema(db, kind);
    expectBackups(backups);
  });

  it("treats claimed fork v4 without policy as fork v3 pending upgrade", async () => {
    await createHistoricalDatabase("fork-v4", { policyColumn: false });
    let db = await bootDatabase();
    expectCurrentSchema(db, "fork-v4");
    expectBackups(1);

    db = await restartDatabase(db);
    expectCurrentSchema(db, "fork-v4");
    expectBackups(1);
  });

  it("fails closed for an unrecognized official schemaVersion above latest", async () => {
    await createHistoricalDatabase("official-v1");
    const db = await createTestAdapter(databaseFile());
    db.run(`UPDATE _meta SET value = '2' WHERE key = 'schemaVersion'`);
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");

    await expect(runMigrationOnce(db)).rejects.toThrow(/official schemaVersion 2 is newer than supported 1/);
    expect(db.all(`PRAGMA table_info(apiKeys)`).map((column) => column.name)).not.toContain("policy");
    expect(db.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codexResetCreditAttempts'`,
    )).toBeUndefined();
    expect(backupCount()).toBe(0);
    db.close();
  });

  it.each([
    ["backupSchemaVersion", "2", /official backupSchemaVersion 2 is newer than supported 1/],
    ["forkBackupSchemaVersion", "5", /fork forkBackupSchemaVersion 5 is newer than supported 4/],
  ])("fails closed for a newer declarative %s", async (key, value, expected) => {
    await createHistoricalDatabase("official-v1");
    const db = await createTestAdapter(databaseFile());
    db.run(`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");

    await expect(runMigrationOnce(db)).rejects.toThrow(expected);
    expect(metadata(db)[key]).toBe(value);
    expect(backupCount()).toBe(0);
    db.close();
  });

  it("does not rewrite newer fork metadata on a legacy physical fingerprint", async () => {
    await createHistoricalDatabase("fork-v4");
    const db = await createTestAdapter(databaseFile());
    db.run(`INSERT INTO _meta(key, value) VALUES('forkSchemaVersion', '2')`);
    db.run(`INSERT INTO _meta(key, value) VALUES('forkBackupSchemaVersion', '5')`);
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");

    await expect(runMigrationOnce(db)).rejects.toThrow(/official schemaVersion 2 is newer than supported 1/);
    expect(metadata(db).schemaVersion).toBe("2");
    expect(metadata(db).forkSchemaVersion).toBe("2");
    expect(metadata(db).forkBackupSchemaVersion).toBe("5");
    expect(backupCount()).toBe(0);
    db.close();
  });

  it("normalizes legacy fork schemaVersion 2 before an injected future official #2", async () => {
    await createHistoricalDatabase("fork-v4");
    const db = await createTestAdapter(databaseFile());
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const { normalizeLegacyForkMetadata, runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const futureOfficialMigration = {
      version: 2,
      name: "future-official-sentinel",
      up(adapter) {
        adapter.exec(`CREATE TABLE futureOfficialSentinel (id INTEGER PRIMARY KEY)`);
      },
    };

    expect(normalizeLegacyForkMetadata(db)).toBe(true);
    expect(metadata(db).schemaVersion).toBe("1");
    const result = runVersionedMigrations(db, {
      migrations: [...MIGRATIONS, futureOfficialMigration],
      metaKey: "schemaVersion",
      label: "official-test",
    });

    expect(result.applied).toBe(1);
    expect(metadata(db).schemaVersion).toBe("2");
    expect(db.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'futureOfficialSentinel'`,
    )?.name).toBe("futureOfficialSentinel");
    db.close();
  });

  it("stamps both backup namespaces after legacy JSON import", async () => {
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify({
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    }));

    const db = await bootDatabase();
    const meta = metadata(db);
    expect(meta.backupSchemaVersion).toBe("1");
    expect(meta.forkBackupSchemaVersion).toBe("4");
    expect(JSON.parse(db.get(`SELECT data FROM settings WHERE id = 1`).data)).toEqual({ foo: "legacy-value" });
    expect(db.all(`SELECT * FROM apiKeys`)).toHaveLength(1);
    expect(db.all(`SELECT * FROM kv WHERE scope = 'modelAliases'`)).toHaveLength(1);
  });

  it("auto-sync re-creates a missing index without another backup", async () => {
    let db = await bootDatabase();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    db = await restartDatabase(db);

    expect(db.all(`PRAGMA index_list(providerNodes)`).map((index) => index.name)).toContain("idx_pn_type");
    expect(backupCount()).toBe(0);
  });
});
