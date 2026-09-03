import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { modelThinking } from "../../open-sse/providers/models/schema.js";
import { getModelSupportedFormats, getModelThinking } from "../../open-sse/config/providerModels.js";
import {
  applyModelOverridePatch,
  buildForcedTransport,
  normalizeProtocol,
  overrideLookupKeys,
  protocolOptionsForModel,
  resolveChatRouting,
  resolveModelOverride,
  thinkingIntentFromOverride,
} from "../../open-sse/services/modelOverrides.js";
import { resolveTransportForFormat } from "../../open-sse/services/provider.js";

describe("schema modelThinking", () => {
  it("reads an explicit registry thinking field", () => {
    expect(modelThinking({ id: "gpt-5.6-sol", thinking: "high" })).toBe("high");
  });
  it("defaults to null when undeclared", () => {
    expect(modelThinking({ id: "gpt-4o" })).toBeNull();
    expect(getModelThinking("opencode-go", "deepseek-v4-flash")).toBeNull();
  });
});

describe("applyModelOverridePatch", () => {
  it("computes a persistable map without relying on React setState", () => {
    const next = applyModelOverridePatch({}, "opencode-go/muse-spark-1.2-contributor", {
      protocol: "openai-responses",
    });
    expect(next).toEqual({
      "opencode-go/muse-spark-1.2-contributor": { protocol: "openai-responses" },
    });
  });

  it("drops auto values and empty entries", () => {
    const next = applyModelOverridePatch(
      { "opencode-go/muse-spark-1.2-contributor": { protocol: "openai-responses", thinking: "high" } },
      "opencode-go/muse-spark-1.2-contributor",
      { protocol: "auto", thinking: "auto" },
    );
    expect(next).toEqual({});
  });
});

describe("normalizeProtocol + lookup keys", () => {
  it("maps UI aliases and wire formats", () => {
    expect(normalizeProtocol("chat")).toBe(FORMATS.OPENAI);
    expect(normalizeProtocol("responses")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(normalizeProtocol("messages")).toBe(FORMATS.CLAUDE);
    expect(normalizeProtocol("openai-responses")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(normalizeProtocol("auto")).toBeNull();
  });

  it("normalizes thinking suffixes and digit-hyphen versions", () => {
    expect(overrideLookupKeys("opencode-go", "deepseek-v4-flash(high)")).toContain("opencode-go/deepseek-v4-flash");
    expect(overrideLookupKeys("kiro", "claude-sonnet-4-5")).toContain("kiro/claude-sonnet-4.5");
  });
});

describe("resolveModelOverride merge", () => {
  it("prefers connection over settings over registry thinking", () => {
    const resolved = resolveModelOverride({
      provider: "opencode-go",
      model: "deepseek-v4-flash(high)",
      credentials: { providerSpecificData: { modelConfigs: { "deepseek-v4-flash": { thinking: "max", protocol: "chat" } } } },
      settings: { modelOverrides: { "opencode-go/deepseek-v4-flash": { thinking: "high", protocol: "messages" } } },
    });
    expect(resolved.thinking).toBe("max");
    expect(resolved.protocol).toBe(FORMATS.OPENAI);
  });

  it("uses settings when connection has no entry", () => {
    const resolved = resolveModelOverride({
      provider: "opencode-go",
      model: "minimax-m3",
      credentials: {},
      settings: { modelOverrides: { "opencode-go/minimax-m3": { protocol: "messages", thinking: "high" } } },
    });
    expect(resolved.thinking).toBe("high");
    expect(resolved.protocol).toBe(FORMATS.CLAUDE);
  });
});

describe("thinkingIntentFromOverride", () => {
  it("builds a forced level intent", () => {
    expect(thinkingIntentFromOverride("max", "opencode-go", "deepseek-v4-flash")).toEqual({
      mode: "level",
      level: "max",
      force: true,
    });
  });

  it("returns null for an illegal level so chatCore can fall back", () => {
    expect(thinkingIntentFromOverride("banana", "opencode-go", "deepseek-v4-flash")).toBeNull();
  });
});

describe("resolveChatRouting protocol force", () => {
  it("keeps the existing sourceFormat-matched transport when no override is set", () => {
    const routing = resolveChatRouting({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      sourceFormat: FORMATS.CLAUDE,
    });
    expect(routing.targetFormat).toBe(FORMATS.CLAUDE);
    expect(routing.useTransport?.baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  it("forces responses on an undeclared custom model even when the client sent chat", () => {
    const routing = resolveChatRouting({
      provider: "opencode-go",
      model: "muse-spark-1.2-contributor",
      sourceFormat: FORMATS.OPENAI,
      settings: {
        modelOverrides: {
          "opencode-go/muse-spark-1.2-contributor": { protocol: "openai-responses" },
        },
      },
    });
    expect(routing.targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
    expect(routing.useTransport?.baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
  });

  it("routes Muse Spark to responses by default (no override needed)", () => {
    const routing = resolveChatRouting({
      provider: "opencode-go",
      model: "muse-spark-1.3-contributor",
      sourceFormat: FORMATS.OPENAI,
    });
    expect(routing.targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
    expect(routing.useTransport?.baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
  });

  it("forces chat transport even when the client sent messages", () => {    const routing = resolveChatRouting({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      sourceFormat: FORMATS.CLAUDE,
      settings: { modelOverrides: { "opencode-go/deepseek-v4-flash": { protocol: "chat", thinking: "max" } } },
    });
    expect(routing.targetFormat).toBe(FORMATS.OPENAI);
    expect(routing.useTransport?.baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(routing.thinkingIntent).toEqual({ mode: "level", level: "max", force: true });
  });

  it("does not force messages on a chat-only model", () => {
    const routing = resolveChatRouting({
      provider: "opencode-go",
      model: "glm-5.2",
      sourceFormat: FORMATS.OPENAI,
      settings: { modelOverrides: { "opencode-go/glm-5.2": { protocol: "messages" } } },
      log: { warn: () => {} },
    });
    expect(getModelSupportedFormats("opencode-go", "glm-5.2")).toEqual(["openai"]);
    expect(routing.targetFormat).toBe(FORMATS.OPENAI);
    expect(routing.useTransport?.baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("ignores protocol force on binary providers", () => {
    const routing = resolveChatRouting({
      provider: "kiro",
      model: "claude-sonnet-4.5",
      sourceFormat: FORMATS.CLAUDE,
      settings: { modelOverrides: { "kiro/claude-sonnet-4.5": { protocol: "chat" } } },
      log: { warn: () => {} },
    });
    expect(routing.targetFormat).toBe("kiro");
  });

  it("builds a synthetic openai-compatible transport", () => {
    const transport = buildForcedTransport(
      "openai-compatible-chat-test",
      FORMATS.OPENAI_RESPONSES,
      { providerSpecificData: { baseUrl: "https://example.test/v1" } },
    );
    expect(transport).toEqual({
      format: FORMATS.OPENAI_RESPONSES,
      baseUrl: "https://example.test/v1/responses",
    });
  });
});

describe("protocolOptionsForModel + resolveTransportForFormat", () => {
  it("lists declared formats for OpenCode Go DeepSeek", () => {
    expect(protocolOptionsForModel("opencode-go", "deepseek-v4-flash")).toEqual([
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
    ]);
  });

  it("lists only chat for GLM", () => {
    expect(protocolOptionsForModel("opencode-go", "glm-5.2")).toEqual([FORMATS.OPENAI]);
  });

  it("resolves transports by target format", () => {
    expect(resolveTransportForFormat("opencode-go", FORMATS.OPENAI_RESPONSES).baseUrl)
      .toBe("https://opencode.ai/zen/go/v1/responses");
  });
});
