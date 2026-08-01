import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerMap = vi.hoisted(() => ({}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => Response.json(body, init),
  },
}));

vi.mock("@/models", () => ({ getProviderNodeById: vi.fn() }));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: providerMap,
  isAnthropicCompatibleProvider: () => false,
  isCustomEmbeddingProvider: () => false,
  isOpenAICompatibleProvider: () => false,
}));

vi.mock("open-sse/config/providerModels.js", () => ({
  getDefaultModel: () => "test-model",
}));

vi.mock("open-sse/config/providers.js", () => ({
  PROVIDERS: {},
  resolveOllamaLocalHost: vi.fn(),
  resolveXiaomiTokenplanBaseUrl: vi.fn(),
}));

vi.mock("open-sse/translator/request/openai-to-commandcode.js", () => ({
  openaiToCommandCodeRequest: vi.fn(),
}));

vi.mock("@/lib/providerNormalization", () => ({
  normalizeProviderId: (provider) => provider,
}));

const { POST } = await import("@/app/api/providers/validate/route.js");

const STEP_PLAN_MODELS_URL = "https://api.stepfun.com/step_plan/v1/models";
const STEP_PLAN_GENERATION_URL = "https://api.stepfun.com/step_plan/v1/images/generations";

function requestFor(provider, apiKey = "step-plan-key") {
  return { json: async () => ({ provider, apiKey }) };
}

async function responseBody(response) {
  return response.json();
}

describe("provider validation route media probes", () => {
  beforeEach(() => {
    providerMap["step-plan"] = {
      serviceKinds: ["image"],
      imageConfig: {
        baseUrl: STEP_PLAN_GENERATION_URL,
        authHeader: "bearer",
        validateUrl: STEP_PLAN_MODELS_URL,
        validateMethod: "GET",
      },
    };
    providerMap["legacy-image"] = {
      serviceKinds: ["image"],
      imageConfig: {
        baseUrl: "https://legacy.example/v1/images/generations",
        authHeader: "bearer",
      },
    };
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete providerMap["step-plan"];
    delete providerMap["legacy-image"];
  });

  it("validates Step Plan with exactly one authenticated GET and no body", async () => {
    fetch.mockResolvedValue({ status: 200 });

    const body = await responseBody(await POST(requestFor("step-plan")));

    expect(body).toEqual({ valid: true, error: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(STEP_PLAN_MODELS_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer step-plan-key",
      },
      body: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(fetch.mock.calls[0][0]).not.toBe(STEP_PLAN_GENERATION_URL);
  });

  it.each([200, 204, 299])("accepts Step Plan validation status %s", async (status) => {
    fetch.mockResolvedValue({ status });

    expect(await responseBody(await POST(requestFor("step-plan")))).toEqual({
      valid: true,
      error: null,
    });
  });

  it.each([401, 403, 400, 404, 429, 300, 500])("rejects Step Plan validation status %s", async (status) => {
    fetch.mockResolvedValue({ status });

    expect(await responseBody(await POST(requestFor("step-plan")))).toEqual({
      valid: false,
      error: "Invalid API key",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["network failure", new Error("network unavailable")],
    ["timeout", new DOMException("The operation timed out", "TimeoutError")],
  ])("rejects Step Plan on %s without generation fallback", async (_label, failure) => {
    fetch.mockRejectedValue(failure);

    const body = await responseBody(await POST(requestFor("step-plan")));

    expect(body.valid).toBe(false);
    expect(body.error).toBe(failure.message);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(STEP_PLAN_MODELS_URL);
  });

  it("defaults validation metadata to GET", async () => {
    delete providerMap["step-plan"].imageConfig.validateMethod;
    fetch.mockResolvedValue({ status: 200 });

    await POST(requestFor("step-plan"));

    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: "GET",
      body: undefined,
    }));
  });

  it.each([400, 404, 429, 500])("preserves legacy acceptance for status %s without validation metadata", async (status) => {
    fetch.mockResolvedValue({ status });

    expect(await responseBody(await POST(requestFor("legacy-image", "legacy-key")))).toEqual({
      valid: true,
      error: null,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://legacy.example/v1/images/generations",
      expect.objectContaining({ method: "POST", body: expect.any(String) }),
    );
  });

  it.each([401, 403])("preserves legacy auth rejection for status %s", async (status) => {
    fetch.mockResolvedValue({ status });

    expect(await responseBody(await POST(requestFor("legacy-image")))).toEqual({
      valid: false,
      error: "Invalid API key",
    });
  });
});
