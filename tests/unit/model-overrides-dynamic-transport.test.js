import { afterEach, describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { setCustomModelFormatOverlay } from "../../open-sse/config/customModelFormats.js";
import { resolveChatRouting } from "../../open-sse/services/modelOverrides.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

afterEach(() => setCustomModelFormatOverlay([]));

describe("dynamic compatible model transport fallback", () => {
  it("keeps the static provider default path when no source transport or model target exists", () => {
    const routing = resolveChatRouting({
      provider: "opencode-go",
      model: "undeclared-model",
      sourceFormat: FORMATS.GEMINI,
    });
    expect(routing.targetFormat).toBe(FORMATS.OPENAI);
    expect(routing.useTransport).toBeNull();
  });

  it.each([
    ["chat", FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "/responses"],
    ["responses", FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "/chat/completions"],
  ])("routes a %s node to its custom model's target endpoint", (apiType, sourceFormat, targetFormat, path) => {
    const provider = `openai-compatible-${apiType}-test`;
    const model = "custom-model";
    const credentials = { providerSpecificData: { apiType, baseUrl: "https://example.test/v1/" } };
    setCustomModelFormatOverlay([{ providerAlias: provider, id: model, supportedFormats: [targetFormat], targetFormat }]);
    const routing = resolveChatRouting({ provider, model, sourceFormat, credentials });
    expect(routing.override.protocol).toBeNull();
    expect(routing.targetFormat).toBe(targetFormat);
    // Exercise the real outbound URL builder without making a provider call.
    const executor = new DefaultExecutor(provider);
    expect(executor.buildUrl(model, false, 0, { ...credentials, runtimeTransport: routing.useTransport }))
      .toBe(`https://example.test/v1${path}`);
    expect(routing.useTransport).toEqual({ format: targetFormat, baseUrl: `https://example.test/v1${path}` });
  });
  it.each([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])(
    "keeps OpenCode Go's existing %s source transport despite a different model target",
    (sourceFormat) => {
      setCustomModelFormatOverlay([{
        providerAlias: "opencode-go", id: "custom-multiformat-model",
        supportedFormats: [FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES],
        targetFormat: sourceFormat === FORMATS.OPENAI ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI,
      }]);
      const routing = resolveChatRouting({ provider: "opencode-go", model: "custom-multiformat-model", sourceFormat });
      expect(routing.targetFormat).toBe(sourceFormat);
      expect(routing.useTransport).toBe(resolveTransport("opencode-go", sourceFormat));
    },
  );
});
