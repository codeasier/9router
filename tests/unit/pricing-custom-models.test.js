import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addPricingRow,
  EMPTY_RATES,
  lookupUserPricing,
  mergeCustomModelsIntoPricing,
  normalizeRates,
  removePricingRow,
  sortPricingProviders,
  providerPricingLabel,
} from "../../src/shared/utils/pricingEditor.js";

describe("pricing editor helpers", () => {
  it("seeds custom models without overwriting catalog or user rates", () => {
    const merged = {
      gh: { "gpt-5.3-codex": { input: 1.75, output: 14 } },
      cc: { "already": { input: 9, output: 9 } },
    };
    mergeCustomModelsIntoPricing(merged, [
      { providerAlias: "cc", id: "already", name: "Already" },
      { providerAlias: "cc", id: "my-finetune", name: "Mine" },
      { providerAlias: "openai", id: "gpt-4o" },
      { id: "missing-provider" },
    ], (provider, model) => (model === "gpt-4o" ? { input: 2.5, output: 10 } : null));

    expect(merged.cc.already).toEqual({ input: 9, output: 9 });
    expect(merged.cc["my-finetune"]).toEqual(EMPTY_RATES);
    expect(merged.openai["gpt-4o"].input).toBe(2.5);
    expect(merged.openai["gpt-4o"].output).toBe(10);
    expect(merged.gh["gpt-5.3-codex"].input).toBe(1.75);
  });

  it("seeds a Codex custom model under the cx alias", () => {
    const merged = {};
    mergeCustomModelsIntoPricing(merged, [
      { providerAlias: "cx", id: "gpt-6-astra", name: "GPT 6 Astra" },
    ], () => null);
    expect(merged.cx["gpt-6-astra"]).toEqual(EMPTY_RATES);
  });

  it("labels Codex by name and alias", () => {
    expect(providerPricingLabel("cx", () => ({ alias: "cx", name: "Codex" }))).toBe("Codex (cx)");
    expect(providerPricingLabel("unknown")).toBe("UNKNOWN");
  });

  it("adds and removes editable rows", () => {
    const added = addPricingRow({}, " cc ", " my-model ", { input: 3 });
    expect(added).toEqual({
      added: true,
      data: { cc: { "my-model": { ...EMPTY_RATES, input: 3 } } },
    });
    expect(addPricingRow(added.data, "cc", "my-model", {}).reason).toBe("exists");
    expect(addPricingRow(added.data, "", "x").reason).toBe("empty");
    expect(removePricingRow(added.data, "cc", "my-model")).toEqual({});
  });

  it("looks up user pricing by alias or id", () => {
    const user = { cc: { "my-model": { input: 4, output: 8 } } };
    expect(lookupUserPricing(user, "claude", "my-model", ["cc"])).toEqual({ input: 4, output: 8 });
    expect(lookupUserPricing(user, "cc", "my-model")).toEqual({ input: 4, output: 8 });
    expect(lookupUserPricing(user, "openai", "my-model", ["oa"])).toBeNull();
  });

  it("sorts providers with user-owned models first", () => {
    const catalog = { gh: { a: EMPTY_RATES }, tokenrouter: { b: EMPTY_RATES } };
    const data = {
      tokenrouter: { b: EMPTY_RATES },
      cc: { "my-model": EMPTY_RATES },
      gh: { a: EMPTY_RATES },
    };
    expect(sortPricingProviders(["tokenrouter", "gh", "cc"], data, catalog, new Set(["cc|my-model"])))
      .toEqual(["cc", "gh", "tokenrouter"]);
  });

  it("fills missing rate fields with zero", () => {
    expect(normalizeRates({ input: 1, output: "2", cached: -1 })).toEqual({
      ...EMPTY_RATES,
      input: 1,
      output: 2,
    });
  });
});

describe("pricing repo includes custom models", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-custom-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  beforeEach(async () => {
    await db.resetAllPricing();
  });

  it("lists a custom model even before a user override exists", async () => {
    await db.addCustomModel({ providerAlias: "cc", id: "my-finetune", name: "Mine" });
    const pricing = await db.getPricing();
    expect(pricing.cc["my-finetune"]).toMatchObject(EMPTY_RATES);
    expect(pricing.gh).toBeDefined();
    expect(pricing.tokenrouter).toBeDefined();
  });

  it("keeps a saved custom override and finds it by provider id", async () => {
    await db.addCustomModel({ providerAlias: "cc", id: "my-finetune" });
    await db.updatePricing({ cc: { "my-finetune": { input: 7, output: 21, cached: 0.7, reasoning: 21, cache_creation: 7 } } });
    expect(await db.getPricingForModel("cc", "my-finetune")).toMatchObject({ input: 7, output: 21 });
    expect(await db.getPricingForModel("claude", "my-finetune")).toMatchObject({ input: 7, output: 21 });
  });

  it("prices a custom Codex model added as cx/gpt-6-astra", async () => {
    await db.addCustomModel({ providerAlias: "cx", id: "gpt-6-astra", name: "GPT 6 Astra" });
    const pricing = await db.getPricing();
    expect(pricing.cx["gpt-6-astra"]).toMatchObject(EMPTY_RATES);

    await db.updatePricing({
      cx: { "gpt-6-astra": { input: 4, output: 16, cached: 0.4, reasoning: 16, cache_creation: 4 } },
    });
    expect(await db.getPricingForModel("cx", "gpt-6-astra")).toMatchObject({ input: 4, output: 16 });
    expect(await db.getPricingForModel("codex", "gpt-6-astra")).toMatchObject({ input: 4, output: 16 });
  });
});
