import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  sanitizeSupportedFormats,
  sanitizeTargetFormat,
  setCustomModelFormatOverlay,
} from "../../open-sse/config/customModelFormats.js";
import { getModelSupportedFormats, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { resolveChatRouting } from "../../open-sse/services/modelOverrides.js";
import { VOLCEAPI_API_ROOT } from "../../open-sse/config/volceapi.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let customFormats;

afterEach(() => {
  setCustomModelFormatOverlay([]);
});

describe("custom model protocol sanitization", () => {
  it("accepts chat / resp / messages aliases and drops unknowns", () => {
    expect(sanitizeSupportedFormats(["chat", "resp", "messages", "gemini"])).toEqual([
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      FORMATS.CLAUDE,
    ]);
    expect(sanitizeSupportedFormats([])).toBeNull();
    expect(sanitizeTargetFormat("messages", [FORMATS.OPENAI])).toBeNull();
    expect(sanitizeTargetFormat("messages", [FORMATS.CLAUDE])).toBe(FORMATS.CLAUDE);
  });
});

describe("custom model format overlay routing", () => {
  it("keeps undeclared models on the source-format transport", () => {
    setCustomModelFormatOverlay([
      { providerAlias: "volceapi", id: "glm-5.3", type: "llm" },
    ]);
    expect(getModelSupportedFormats("volceapi", "glm-5.3")).toBeNull();
    const routing = resolveChatRouting({
      provider: "volceapi",
      model: "glm-5.3",
      sourceFormat: FORMATS.CLAUDE,
    });
    expect(routing.useTransport?.baseUrl).toBe(`${VOLCEAPI_API_ROOT}/messages`);
    expect(routing.targetFormat).toBe(FORMATS.CLAUDE);
  });

  it("guards fallback to the declared target when the client format is unsupported", () => {
    setCustomModelFormatOverlay([
      {
        providerAlias: "volceapi",
        id: "qwen3.8-flash",
        type: "llm",
        supportedFormats: ["openai", "claude"],
        targetFormat: "claude",
      },
    ]);
    expect(getModelSupportedFormats("volceapi", "qwen3.8-flash")).toEqual([FORMATS.OPENAI, FORMATS.CLAUDE]);
    expect(getModelTargetFormat("volceapi", "qwen3.8-flash")).toBe(FORMATS.CLAUDE);

    const claudeClient = resolveChatRouting({
      provider: "volceapi",
      model: "qwen3.8-flash",
      sourceFormat: FORMATS.CLAUDE,
    });
    expect(claudeClient.useTransport?.baseUrl).toBe(`${VOLCEAPI_API_ROOT}/messages`);

    const responsesClient = resolveChatRouting({
      provider: "volceapi",
      model: "qwen3.8-flash",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    expect(responsesClient.targetFormat).toBe(FORMATS.CLAUDE);
    expect(responsesClient.useTransport?.baseUrl).toBe(`${VOLCEAPI_API_ROOT}/messages`);
  });

  it("rejects a protocol override outside the declared set", () => {
    setCustomModelFormatOverlay([
      {
        providerAlias: "volceapi",
        id: "glm-5.3",
        supportedFormats: ["openai"],
      },
    ]);
    const routing = resolveChatRouting({
      provider: "volceapi",
      model: "glm-5.3",
      sourceFormat: FORMATS.OPENAI,
      settings: { modelOverrides: { "volceapi/glm-5.3": { protocol: "messages" } } },
    });
    expect(routing.targetFormat).toBe(FORMATS.OPENAI);
    expect(routing.useTransport?.baseUrl).toBe(`${VOLCEAPI_API_ROOT}/chat/completions`);
  });
});

describe("custom model protocol persistence", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-volceapi-custom-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    customFormats = await import("open-sse/config/customModelFormats.js");
    await db.initDb();
  });

  beforeEach(async () => {
    customFormats?.setCustomModelFormatOverlay([]);
    const existing = await db.getCustomModels();
    for (const model of existing) {
      await db.deleteCustomModel({ providerAlias: model.providerAlias, id: model.id, type: model.type || "llm" });
    }
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    setCustomModelFormatOverlay([]);
  });

  it("stores and updates supportedFormats/targetFormat, then refreshes the overlay", async () => {
    await db.addCustomModel({
      providerAlias: "volceapi",
      id: "glm-5.3",
      type: "llm",
      supportedFormats: ["openai", "claude"],
      targetFormat: "claude",
    });
    const created = (await db.getCustomModels()).find((model) => model.id === "glm-5.3");
    expect(created.supportedFormats).toEqual(["openai", "claude"]);
    expect(created.targetFormat).toBe("claude");
    expect(customFormats.getCustomModelFormatOverlay().some((model) => model.id === "glm-5.3")).toBe(true);

    await db.addCustomModel({
      providerAlias: "volceapi",
      id: "glm-5.3",
      type: "llm",
      supportedFormats: ["openai"],
      targetFormat: "openai",
    });
    const updated = (await db.getCustomModels()).find((model) => model.id === "glm-5.3");
    expect(updated.supportedFormats).toEqual(["openai"]);
    expect(updated.targetFormat).toBe("openai");
    expect(updated.name).toBe("glm-5.3");
  });
});
