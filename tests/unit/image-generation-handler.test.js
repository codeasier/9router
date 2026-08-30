import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
}));

const modelMocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
}));

const tokenMocks = vi.hoisted(() => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

const comboMocks = vi.hoisted(() => ({
  handleComboChat: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  handleImageGenerationCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/lib/localDb", () => settingsMocks);
vi.mock("@/sse/services/model.js", () => modelMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => tokenMocks);
vi.mock("open-sse/services/combo.js", () => comboMocks);
vi.mock("@/sse/utils/logger.js", () => loggerMocks);
vi.mock("open-sse/handlers/imageGenerationCore.js", () => coreMocks);

import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";

const stepPlanModel = "step-plan/step-image-edit-2";

function makeRequest(body, { headers = {}, query = "" } = {}) {
  return new Request(`http://localhost/v1/images/generations${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function connection(connectionId = "step-connection-1") {
  return {
    connectionId,
    authType: "apikey",
    apiKey: `${connectionId}-key`,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  settingsMocks.getSettings.mockResolvedValue({ requireApiKey: false });
  authMocks.extractApiKey.mockReturnValue(null);
  authMocks.isValidApiKey.mockResolvedValue(true);
  authMocks.getProviderCredentials.mockResolvedValue(connection());
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  authMocks.clearAccountError.mockResolvedValue(undefined);
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: "step-plan", model: "step-image-edit-2" });
  tokenMocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  tokenMocks.updateProviderCredentials.mockResolvedValue(undefined);
});

describe("handleImageGeneration", () => {
  it("rejects a missing local API key when local API-key protection is enabled", async () => {
    settingsMocks.getSettings.mockResolvedValue({ requireApiKey: true });

    const response = await handleImageGeneration(makeRequest({ model: stepPlanModel, prompt: "sunrise" }));

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Missing API key");
    expect(authMocks.isValidApiKey).not.toHaveBeenCalled();
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("rejects an invalid local API key before selecting provider credentials", async () => {
    settingsMocks.getSettings.mockResolvedValue({ requireApiKey: true });
    authMocks.extractApiKey.mockReturnValue("invalid-local-key");
    authMocks.isValidApiKey.mockResolvedValue(false);

    const response = await handleImageGeneration(makeRequest({ model: stepPlanModel, prompt: "sunrise" }));

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Invalid API key");
    expect(authMocks.isValidApiKey).toHaveBeenCalledWith("invalid-local-key");
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("passes the preferred Step Plan connection to credential selection", async () => {
    const upstreamResponse = Response.json({ data: [{ url: "https://example.com/image.png" }] });
    coreMocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: upstreamResponse });

    const response = await handleImageGeneration(makeRequest(
      { model: stepPlanModel, prompt: "sunrise" },
      { headers: { "x-connection-id": "preferred-step-plan" } },
    ));

    expect(response).toBe(upstreamResponse);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "step-plan",
      expect.any(Set),
      "step-image-edit-2",
      { preferredConnectionId: "preferred-step-plan" },
    );
  });

  it("falls back to another Step Plan account after a retryable failure", async () => {
    const first = connection("step-connection-1");
    const second = connection("step-connection-2");
    const successResponse = Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    authMocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    coreMocks.handleImageGenerationCore
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "rate limited",
        response: new Response("rate limited", { status: 429 }),
      })
      .mockResolvedValueOnce({ success: true, response: successResponse });

    const response = await handleImageGeneration(makeRequest({ model: stepPlanModel, prompt: "sunrise" }));

    expect(response).toBe(successResponse);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "step-connection-1",
      429,
      "rate limited",
      "step-plan",
      "step-image-edit-2",
    );
    expect(authMocks.getProviderCredentials.mock.calls[1][1]).toEqual(new Set(["step-connection-1"]));
    expect(coreMocks.handleImageGenerationCore.mock.calls[1][0].credentials).toBe(second);
  });

  it("runs a Step Plan model through the existing combo handler", async () => {
    const comboResponse = Response.json({ data: [{ url: "https://example.com/combo.png" }] });
    modelMocks.getComboModels.mockResolvedValue([stepPlanModel]);
    comboMocks.handleComboChat.mockImplementation(async ({ body, models, handleSingleModel }) => {
      return handleSingleModel({ ...body, model: models[0] }, models[0]);
    });
    coreMocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: comboResponse });

    const response = await handleImageGeneration(makeRequest({ model: "image-combo", prompt: "sunrise" }));

    expect(response).toBe(comboResponse);
    expect(comboMocks.handleComboChat).toHaveBeenCalledWith(expect.objectContaining({
      models: [stepPlanModel],
      comboName: "image-combo",
      comboStrategy: "fallback",
      handleSingleModel: expect.any(Function),
    }));
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "step-plan",
      expect.any(Set),
      "step-image-edit-2",
      { preferredConnectionId: null },
    );
  });

  it("returns the image core response unchanged", async () => {
    const upstreamResponse = new Response(JSON.stringify({
      id: "step-result",
      data: [{ url: "https://example.com/image.png", finish_reason: "success", seed: 7 }],
    }), {
      status: 202,
      headers: { "Content-Type": "application/json", "x-upstream": "step-plan" },
    });
    coreMocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: upstreamResponse });

    const response = await handleImageGeneration(makeRequest({ model: stepPlanModel, prompt: "sunrise" }));

    expect(response).toBe(upstreamResponse);
    expect(response.status).toBe(202);
    expect(response.headers.get("x-upstream")).toBe("step-plan");
  });

  it("propagates response_format=binary to the core as binaryOutput true", async () => {
    const binaryResponse = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/png" },
    });
    coreMocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: binaryResponse });

    const response = await handleImageGeneration(makeRequest(
      { model: stepPlanModel, prompt: "sunrise" },
      { query: "?response_format=binary" },
    ));

    expect(response).toBe(binaryResponse);
    expect(coreMocks.handleImageGenerationCore).toHaveBeenCalledWith(expect.objectContaining({
      modelInfo: { provider: "step-plan", model: "step-image-edit-2" },
      binaryOutput: true,
    }));
  });
});
