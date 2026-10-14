import { describe, expect, it } from "vitest";
import { normalizeComboCapabilities, resolveComboCapabilities } from "@/shared/utils/comboCapabilities.js";

describe("Combo model properties", () => {
  it("inherits member metadata by default and supports sparse overrides including false", () => {
    const combo = { name: "fast", models: ["cx/gpt-5.6-sol"] };
    const original = resolveComboCapabilities(combo);
    expect(original.vision).toBe(true);
    expect(original.thinkingLevels).toContain("ultra");
    const customized = resolveComboCapabilities({
      ...combo,
      capabilities: { contextWindow: 1000000, vision: false, thinkingLevels: ["low", "high"] },
    });
    expect(customized).toEqual({ ...original, contextWindow: 1000000, vision: false, thinkingLevels: ["low", "high"] });
    expect(resolveComboCapabilities({ ...combo, capabilities: {} })).toEqual(original);
  });

  it("aggregates nested combo overrides before deriving parent metadata", () => {
    const inner = { name: "inner", models: ["cx/gpt-5.6-sol"], capabilities: {
      contextWindow: 1000000, maxOutput: 100000, vision: false, tools: false, thinkingLevels: ["high"],
    } };
    const outer = { name: "outer", models: ["inner"] };
    expect(resolveComboCapabilities(outer, [inner, outer])).toMatchObject(inner.capabilities);
  });

  it("reports no thinking levels when reasoning is off or disable is forbidden", () => {
    const combo = { name: "fast", models: ["cx/gpt-5.6-sol"] };
    expect(resolveComboCapabilities({ ...combo, capabilities: { reasoning: false } }).thinkingLevels).toEqual([]);
    expect(resolveComboCapabilities({ ...combo, capabilities: {
      thinkingCanDisable: false, thinkingLevels: ["none", "high"],
    } }).thinkingLevels).toEqual(["high"]);
  });

  it("keeps empty combos empty and bounds circular nesting", () => {
    expect(resolveComboCapabilities({ name: "empty", models: [] })).toBeNull();
    const self = { name: "self", models: ["self"] };
    expect(resolveComboCapabilities(self, [self])).toBeDefined();
  });

  it.each([
    [{ contextWindow: 0 }], [{ contextWindow: 1.5 }], [{ maxOutput: "1000" }],
    [{ vision: "false" }], [{ thinkingLevels: ["invalid"] }], [{ thinkingLevels: "high" }],
    [{ contextWindow: 100, maxOutput: 101 }], [{ unexpected: true }], [[]],
  ])("rejects invalid public model properties: %j", (value) => {
    expect(() => normalizeComboCapabilities(value)).toThrow();
  });

  it("normalizes reset and inherited values while retaining explicit empty levels", () => {
    expect(normalizeComboCapabilities(null)).toEqual({});
    expect(normalizeComboCapabilities({ contextWindow: null, vision: false, thinkingLevels: [] })).toEqual({ vision: false, thinkingLevels: [] });
  });
});
