/**
 * Unit tests for the image edits HTTP handler (POST /v1/images/edits)
 *
 * Covers:
 *  - multipart/form-data parsing (model, prompt, image[], mask, n, size, response_format)
 *  - local API-key protection
 *  - local limit enforcement (image count, per-file size, MIME types, prompt length)
 *  - delegation to the shared single-model executor with operation: "edit"
 *  - combo routing
 */

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { IMAGE_EDIT_LIMITS } from "../../open-sse/config/runtimeConfig.js";

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

import { handleImageEdit } from "@/sse/handlers/imageEdit.js";

const stepPlanModel = "step-plan/step-image-edit-2";

function pngFile(name = "input.png", bytes = 3, type = "image/png") {
  return new File([new Uint8Array(bytes)], name, { type });
}

function makeEditRequest({ model = stepPlanModel, prompt = "make it sunset", files = [pngFile()], mask = null, query = "" } = {}) {
  const fd = new FormData();
  if (model) fd.append("model", model);
  fd.append("prompt", prompt);
  for (const f of files) fd.append("image", f);
  if (mask) fd.append("mask", mask);
  fd.append("n", "1");
  fd.append("size", "1024x1024");
  fd.append("response_format", "url");
  return new Request(`http://localhost/v1/images/edits${query}`, {
    method: "POST",
    body: fd,
  });
}

function connection(connectionId = "step-connection-1") {
  return {
    connectionId,
    authType: "apikey",
    apiKey: `${connectionId}-key`,
  };
}

const savedLimits = { ...IMAGE_EDIT_LIMITS };

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

afterEach(() => {
  Object.assign(IMAGE_EDIT_LIMITS, savedLimits);
});

describe("handleImageEdit", () => {
  it("rejects a missing local API key when local API-key protection is enabled", async () => {
    settingsMocks.getSettings.mockResolvedValue({ requireApiKey: true });

    const response = await handleImageEdit(makeEditRequest());

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Missing API key");
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("rejects an invalid local API key before selecting provider credentials", async () => {
    settingsMocks.getSettings.mockResolvedValue({ requireApiKey: true });
    authMocks.extractApiKey.mockReturnValue("bad-key");
    authMocks.isValidApiKey.mockResolvedValue(false);

    const response = await handleImageEdit(makeEditRequest());

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Invalid API key");
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("requires a model", async () => {
    const response = await handleImageEdit(makeEditRequest({ model: null }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing model");
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("requires a prompt", async () => {
    const response = await handleImageEdit(makeEditRequest({ prompt: "" }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing required field: prompt");
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("requires at least one image", async () => {
    const response = await handleImageEdit(makeEditRequest({ files: [] }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing required field: image");
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("rejects more images than the configured limit", async () => {
    IMAGE_EDIT_LIMITS.maxImages = 2;
    const response = await handleImageEdit(makeEditRequest({ files: [pngFile(), pngFile(), pngFile()] }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("At most 2 images allowed");
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("rejects files over the per-file size limit", async () => {
    IMAGE_EDIT_LIMITS.maxFileBytes = 4;
    const response = await handleImageEdit(makeEditRequest({ files: [pngFile("big.png", 5)] }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Image too large");
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("rejects disallowed MIME types", async () => {
    const response = await handleImageEdit(makeEditRequest({ files: [pngFile("bad.txt", 3, "text/plain")] }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Unsupported image type: text/plain");
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("rejects prompts over the configured character limit", async () => {
    IMAGE_EDIT_LIMITS.maxPromptChars = 10;
    const response = await handleImageEdit(makeEditRequest({ prompt: "this prompt is way too long" }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Prompt too long");
    expect(coreMocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("passes parsed images, mask and fields to the core with operation edit", async () => {
    const upstream = Response.json({ data: [{ url: "https://example.com/edited.png" }] });
    coreMocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: upstream });

    const response = await handleImageEdit(makeEditRequest({
      files: [pngFile("one.png", 3), pngFile("two.png", 3)],
      mask: pngFile("mask.png", 3),
    }));

    expect(response).toBe(upstream);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "step-plan",
      expect.any(Set),
      "step-image-edit-2",
      { preferredConnectionId: null },
    );
    expect(coreMocks.handleImageGenerationCore).toHaveBeenCalledWith(expect.objectContaining({
      operation: "edit",
      modelInfo: { provider: "step-plan", model: "step-image-edit-2" },
      credentials: expect.objectContaining({ connectionId: "step-connection-1" }),
    }));

    const coreCall = coreMocks.handleImageGenerationCore.mock.calls[0][0];
    expect(coreCall.body.images).toHaveLength(2);
    expect(coreCall.body.images[0].name).toBe("one.png");
    expect(coreCall.body.images[0].mime).toBe("image/png");
    expect(coreCall.body.images[0].b64).toBe(Buffer.from([0, 0, 0]).toString("base64"));
    expect(coreCall.body.mask.name).toBe("mask.png");
    expect(coreCall.body.n).toBe(1);
    expect(coreCall.body.size).toBe("1024x1024");
    expect(coreCall.body.response_format).toBe("url");
  });

  it("propagates response_format=binary as binaryOutput", async () => {
    const binary = new Response(new Uint8Array([9]), { headers: { "Content-Type": "image/png" } });
    coreMocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: binary });

    const response = await handleImageEdit(makeEditRequest({ query: "?response_format=binary" }));

    expect(response).toBe(binary);
    expect(coreMocks.handleImageGenerationCore).toHaveBeenCalledWith(expect.objectContaining({
      operation: "edit",
      binaryOutput: true,
    }));
  });

  it("runs edits through the combo handler when the model is a combo", async () => {
    const comboResponse = Response.json({ data: [{ url: "https://example.com/combo.png" }] });
    modelMocks.getComboModels.mockResolvedValue([stepPlanModel]);
    comboMocks.handleComboChat.mockImplementation(async ({ body, models, handleSingleModel }) => {
      return handleSingleModel({ ...body, model: models[0] }, models[0]);
    });
    coreMocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: comboResponse });

    const response = await handleImageEdit(makeEditRequest({ model: "image-combo" }));

    expect(response).toBe(comboResponse);
    expect(comboMocks.handleComboChat).toHaveBeenCalledWith(expect.objectContaining({
      models: [stepPlanModel],
      comboName: "image-combo",
      handleSingleModel: expect.any(Function),
    }));
    expect(coreMocks.handleImageGenerationCore).toHaveBeenCalledWith(expect.objectContaining({
      operation: "edit",
    }));
  });

  it("falls back to another account after a retryable edit failure", async () => {
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

    const response = await handleImageEdit(makeEditRequest());

    expect(response).toBe(successResponse);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(coreMocks.handleImageGenerationCore.mock.calls[1][0].credentials).toBe(second);
  });
});
