import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let listeners;
const originalDataDir = process.env.DATA_DIR;
const events = ["beforeExit", "SIGINT", "SIGTERM"];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-properties-"));
  process.env.DATA_DIR = tempDir;
  listeners = new Map(events.map((event) => [event, new Set(process.listeners(event))]));
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const event of events) {
    for (const listener of process.listeners(event)) {
      if (!listeners.get(event).has(listener)) process.removeListener(event, listener);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Combo properties persistence", () => {
  it("preserves overrides across member edits, restart and export/import; supports reset", async () => {
    let db = await import("@/lib/db/index.js");
    const capabilities = { contextWindow: 1000000, vision: false, thinkingLevels: ["low", "high"] };
    const combo = await db.createCombo({ name: "vip", models: ["cx/gpt-5.6-sol"], capabilities });
    await db.updateCombo(combo.id, { name: "renamed", models: ["cx/gpt-6-astra"] });
    global._dbAdapter.instance.close();
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    expect((await db.getComboByName("renamed")).capabilities).toEqual(capabilities);
    const exported = await db.exportDb();
    expect(exported.combos[0].capabilities).toEqual(capabilities);
    await db.deleteCombo(combo.id);
    await db.importDb(exported);
    expect((await db.getComboById(combo.id)).capabilities).toEqual(capabilities);
    await db.updateCombo(combo.id, { capabilities: {} });
    expect((await db.getComboById(combo.id)).capabilities).toEqual({});
  });

  it("imports old combos without properties using automatic metadata", async () => {
    const db = await import("@/lib/db/index.js");
    await db.importDb({ combos: [{ id: "old-1", name: "legacy", models: ["cx/gpt-5.5"] }] });
    expect((await db.getComboById("old-1")).capabilities).toEqual({});
  });
});
