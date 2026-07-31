import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-attempt-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function plannedAttempt(id, redeemRequestId) {
  return {
    id,
    accountIdentity: "workspace-1",
    connectionId: "connection-1",
    creditFingerprint: "credit-1",
    creditExpiresAt: "2026-07-31T12:10:00.000Z",
    availableCountBefore: 1,
    redeemRequestId,
    status: "planned",
    result: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
  };
}

describe("Codex reset-credit attempt repository", () => {
  it("survives adapter restart and allows only one active attempt per account", async () => {
    let repo = await import("@/lib/db/repos/codexResetCreditAttemptsRepo.js");
    const first = await repo.createCodexResetCreditAttempt(plannedAttempt("attempt-1", "redeem-1"));
    expect(first.redeemRequestId).toBe("redeem-1");

    global._dbAdapter.instance.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    repo = await import("@/lib/db/repos/codexResetCreditAttemptsRepo.js");

    expect((await repo.getActiveCodexResetCreditAttempt("workspace-1"))?.redeemRequestId).toBe("redeem-1");
    const duplicate = await repo.createCodexResetCreditAttempt(plannedAttempt("attempt-2", "redeem-2"));
    expect(duplicate.id).toBe("attempt-1");

    await repo.updateCodexResetCreditAttempt("attempt-1", {
      status: "confirmed",
      result: { code: "reset" },
      updatedAt: "2026-07-31T12:01:00.000Z",
    });
    const next = await repo.createCodexResetCreditAttempt(plannedAttempt("attempt-2", "redeem-2"));
    expect(next.id).toBe("attempt-2");
  });
});
