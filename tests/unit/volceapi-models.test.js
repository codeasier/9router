import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { VOLCEAPI_API_ROOT } from "../../open-sse/config/volceapi.js";
import {
  USAGE_APIKEY_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
} from "../../src/shared/constants/providers.js";

describe("volceapi registry", () => {
  it("is an apikey provider with an empty static catalog", () => {
    expect((PROVIDER_MODELS.volceapi || []).map((model) => model.id)).toEqual([]);
    expect(PROVIDERS.volceapi.baseUrl).toBe(`${VOLCEAPI_API_ROOT}/chat/completions`);
    expect(PROVIDERS.volceapi.validateUrl).toBe(`${VOLCEAPI_API_ROOT}/models`);
  });

  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("volceapi");
    expect(USAGE_APIKEY_PROVIDERS).toContain("volceapi");
  });

  it("declares openai / claude / openai-responses transports on the unified root", () => {
    const transports = PROVIDERS.volceapi.transports || [];
    expect(transports.map((row) => row.format)).toEqual(["openai", "claude", "openai-responses"]);
    expect(resolveTransport("volceapi", "openai").baseUrl).toBe(`${VOLCEAPI_API_ROOT}/chat/completions`);
    expect(resolveTransport("volceapi", "claude").baseUrl).toBe(`${VOLCEAPI_API_ROOT}/messages`);
    expect(resolveTransport("volceapi", "openai-responses").baseUrl).toBe(`${VOLCEAPI_API_ROOT}/responses`);
  });

  it("uses Bearer on every transport, including messages", () => {
    for (const format of ["openai", "claude", "openai-responses"]) {
      const transport = resolveTransport("volceapi", format);
      expect(transport.auth.header).toBe("Authorization");
      expect(transport.auth.scheme).toBe("bearer");
    }
    expect(resolveTransport("volceapi", "claude").auth.anthropicVersion).toBe(true);
    expect(resolveTransport("volceapi", "claude").auth.header).not.toBe("x-api-key");
  });

  it("leaves undeclared custom models without a supportedFormats guard", () => {
    expect(getModelSupportedFormats("volceapi", "glm-5.3")).toBeNull();
  });
});
