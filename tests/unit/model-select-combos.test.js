import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadModelSelectCombos,
  toComboModelOption,
} from "../../src/shared/components/modelSelectCombos.js";
import { applyClaudeModelMappings } from "../../src/app/(dashboard)/dashboard/cli-tools/components/claudeModelMappings.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modelSelectSource = readFileSync(
  path.join(repoRoot, "src/shared/components/ModelSelectModal.js"),
  "utf8"
);
const claudeToolSource = readFileSync(
  path.join(repoRoot, "src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js"),
  "utf8"
);

describe("CLI model selector combos", () => {
  it("loads combos from the dashboard API", async () => {
    const combos = [
      { id: "combo-1", name: "myOpus", models: ["ant/claude-opus"] },
      { id: "combo-2", name: "mySonnet", kind: "llm", models: ["ant/claude-sonnet"] },
      { id: "combo-3", name: "myImage", kind: "image", models: ["xai/grok-imagine"] },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ combos }),
    });

    await expect(loadModelSelectCombos(fetchImpl)).resolves.toEqual(combos.slice(0, 2));
    expect(fetchImpl).toHaveBeenCalledWith("/api/combos");
  });

  it("treats a missing combo list as empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });

    await expect(loadModelSelectCombos(fetchImpl)).resolves.toEqual([]);
  });

  it("rejects an unsuccessful combo response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(loadModelSelectCombos(fetchImpl)).rejects.toThrow(
      "Failed to fetch combos: 500"
    );
  });

  it("displays combos before provider models", () => {
    expect(modelSelectSource).toContain("setCombos(await loadModelSelectCombos())");
    expect(modelSelectSource).toMatch(
      /useEffect\(\(\) => \{\s*if \(isOpen\) fetchCombos\(\);\s*\}, \[isOpen\]\)/
    );

    const comboSection = modelSelectSource.indexOf("{filteredCombos.length > 0");
    const providerSection = modelSelectSource.indexOf("{Object.entries(filteredGroups)");
    expect(comboSection).toBeGreaterThan(-1);
    expect(providerSection).toBeGreaterThan(comboSection);
  });

  it("passes a combo's bare name into Claude model mappings", () => {
    expect(toComboModelOption({ id: "combo-1", name: "myOpus" })).toEqual({
      id: "myOpus",
      name: "myOpus",
      value: "myOpus",
    });
    expect(modelSelectSource).toContain("handleSelect(toComboModelOption(combo))");
    const env = { ANTHROPIC_BASE_URL: "http://localhost:20128/v1" };
    applyClaudeModelMappings(
      env,
      [{ alias: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" }],
      { opus: "myOpus" }
    );
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("myOpus");
    expect(claudeToolSource).toMatch(
      /onModelMappingChange\(currentEditingAlias, model\.value\)/
    );
    expect(claudeToolSource).toContain(
      "applyClaudeModelMappings(env, tool.defaultModels, modelMappings)"
    );
    expect(claudeToolSource).toMatch(
      /<ModelSelectModal\b[\s\S]*?\bonSelect=\{handleModelSelect\}/
    );
  });
});
