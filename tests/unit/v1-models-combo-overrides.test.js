import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const limits = {
  "mimo-v2.5": { contextWindow: 180000, maxOutput: 16000 },
  "kimi-k2.5": { contextWindow: 120000, maxOutput: 32000 },
};
const first = "ocg/mimo-v2.5";
const second = "ocg/kimi-k2.5";

async function published(combos, name = combos.at(-1).name) {
  db.getCombos.mockResolvedValue(combos);
  const models = await buildModelsList(["llm"], { combosOnly: true });
  return models.find((model) => model.id === name);
}

function expectLimits(model, contextWindow, maxOutput, capabilityMaxOutput = maxOutput) {
  expect(model).toMatchObject({
    capabilities: { contextWindow, maxOutput: capabilityMaxOutput },
    context_length: contextWindow,
    max_completion_tokens: maxOutput,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  setCatalogSource({
    getModalities: () => null,
    getLimits: (provider, model) => provider === "opencode-go" ? limits[model] : null,
  });
});

afterEach(() => {
  setCatalogSource(null);
  vi.unstubAllGlobals();
});

describe("/v1/models final combo metadata", () => {
  it.each([false, true])("publishes manual limits consistently, nested=%s", async (nested) => {
    const inner = { name: "inner", models: [first], capabilities: { contextWindow: 64000, maxOutput: 8000 } };
    const outer = { name: "outer", models: ["inner"] };
    expectLimits(await published(nested ? [inner, outer] : [inner]), 64000, 8000);
  });

  it.each([undefined, {}])("retains conservative advertised limits and official capabilities without overrides (%j)", async (capabilities) => {
    expectLimits(await published([{ name: "auto", models: [first, second], capabilities }]), 120000, 16000, 32000);
  });

  it("retains official aggregation through nested combos without overrides", async () => {
    expectLimits(await published([
      { name: "inner", models: [first, second] },
      { name: "outer", models: ["inner", first] },
    ]), 120000, 16000, 32000);
  });

  it.each([
    [{ contextWindow: 256000 }, 256000, 16000, 32000],
    [{ maxOutput: 48000 }, 120000, 48000, 48000],
  ])("applies sparse overrides above member limits (%j)", async (capabilities, context, output, capsOutput) => {
    expectLimits(await published([{ name: "manual", models: [first, second], capabilities }]), context, output, capsOutput);
  });

  it("aggregates a child override with sibling members before applying the parent override", async () => {
    const inner = { name: "inner", models: [first], capabilities: { contextWindow: 64000, maxOutput: 48000 } };
    const outer = { name: "outer", models: ["inner", second] };
    expectLimits(await published([inner, outer]), 64000, 32000, 48000);
    outer.capabilities = { contextWindow: 256000, maxOutput: 8000 };
    expectLimits(await published([inner, outer]), 256000, 8000);
    expectLimits(await published([inner, outer], "inner"), 64000, 48000);
  });

  it("keeps unrelated capability overrides, including false and empty levels", async () => {
    const model = await published([{ name: "manual", models: [first], capabilities: {
      vision: false, tools: false, reasoning: false, thinkingLevels: [], contextWindow: 64000,
    } }]);
    expectLimits(model, 64000, 16000);
    expect(model.capabilities).toMatchObject({ vision: false, tools: false, reasoning: false, thinkingLevels: [] });
  });

  it("keeps empty combos empty but publishes an empty combo's explicit limits", async () => {
    expect(await published([{ name: "empty", models: [] }])).toEqual({ id: "empty", object: "model", owned_by: "combo" });
    expectLimits(await published([{ name: "manual", models: [], capabilities: { contextWindow: 64000, maxOutput: 8000 } }]), 64000, 8000);
  });

  it("keeps cycle-only advertised limits absent", async () => {
    const combos = [{ name: "a", models: ["b"] }, { name: "b", models: ["a"] }];
    const model = await published(combos);
    expect(model).not.toHaveProperty("context_length");
    expect(model).not.toHaveProperty("max_completion_tokens");
  });

  it("ignores invalid advertised-limit overrides in legacy records", async () => {
    const model = await published([{ name: "legacy", models: [first], capabilities: {
      contextWindow: null, maxOutput: -1,
    } }]);
    expect(model.context_length).toBe(180000);
    expect(model.max_completion_tokens).toBe(16000);
  });
});
