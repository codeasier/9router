import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const ACTIVE_STATUSES = ["planned", "dispatching", "unknown", "auth_required"];

function rowToAttempt(row) {
  if (!row) return null;
  return {
    ...row,
    result: parseJson(row.result, null),
  };
}

export async function getActiveCodexResetCreditAttempt(accountIdentity) {
  const db = await getAdapter();
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
  return rowToAttempt(db.get(
    `SELECT * FROM codexResetCreditAttempts WHERE accountIdentity = ? AND status IN (${placeholders}) ORDER BY createdAt DESC LIMIT 1`,
    [accountIdentity, ...ACTIVE_STATUSES],
  ));
}

export async function getLatestCodexResetCreditAttempt(accountIdentity, creditFingerprint) {
  const db = await getAdapter();
  return rowToAttempt(db.get(
    `SELECT * FROM codexResetCreditAttempts WHERE accountIdentity = ? AND creditFingerprint = ? ORDER BY createdAt DESC LIMIT 1`,
    [accountIdentity, creditFingerprint],
  ));
}

export async function createCodexResetCreditAttempt(attempt) {
  const db = await getAdapter();
  let result;
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
  try {
    db.transaction(() => {
      const active = db.get(
        `SELECT * FROM codexResetCreditAttempts WHERE accountIdentity = ? AND status IN (${placeholders}) ORDER BY createdAt DESC LIMIT 1`,
        [attempt.accountIdentity, ...ACTIVE_STATUSES],
      );
      if (active) {
        result = rowToAttempt(active);
        return;
      }

      db.run(
        `INSERT INTO codexResetCreditAttempts(
          id, accountIdentity, connectionId, creditFingerprint, creditExpiresAt,
          availableCountBefore, redeemRequestId, status, result, createdAt, updatedAt
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          attempt.accountIdentity,
          attempt.connectionId,
          attempt.creditFingerprint,
          attempt.creditExpiresAt || null,
          attempt.availableCountBefore,
          attempt.redeemRequestId,
          attempt.status,
          stringifyJson(attempt.result ?? null),
          attempt.createdAt,
          attempt.updatedAt,
        ],
      );
      result = { ...attempt };
    });
  } catch (error) {
    // A competing process may have committed after our initial SELECT. Query
    // again after rollback so this connection no longer holds a stale snapshot.
    for (const delayMs of [0, 10, 30]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const winner = db.get(
        `SELECT * FROM codexResetCreditAttempts WHERE accountIdentity = ? AND status IN (${placeholders}) ORDER BY createdAt DESC LIMIT 1`,
        [attempt.accountIdentity, ...ACTIVE_STATUSES],
      );
      if (winner) return rowToAttempt(winner);
    }
    throw error;
  }
  db.flush?.();
  return result;
}

export async function updateCodexResetCreditAttempt(id, updates) {
  const db = await getAdapter();
  const allowed = ["connectionId", "status", "result", "updatedAt"];
  const entries = Object.entries(updates).filter(([key]) => allowed.includes(key));
  if (entries.length === 0) return null;
  const values = entries.map(([key, value]) => key === "result" ? stringifyJson(value ?? null) : value);
  db.run(
    `UPDATE codexResetCreditAttempts SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
    [...values, id],
  );
  return rowToAttempt(db.get(`SELECT * FROM codexResetCreditAttempts WHERE id = ?`, [id]));
}
