/**
 * Unit tests for image editing (operation: "edit") in handleImageGenerationCore
 *
 * Covers:
 *  - Step Plan edits endpoint (multipart forward to /images/edits)
 *  - Gemini edits (input images as inlineData parts)
 *  - OpenAI-compatible edits (multipart forward, mask passthrough)
 *  - Codex edits (reference images as data URLs)
 *  - Local rejection of unsupported providers / missing images / timeout
 *  - Multipart Content-Type stripping (boundary must be fetch-generated)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const originalFetch = global.fetch;

function makeImage(b64 = "aGVsbG8=", mime = "image/png", name = "input.png") {
  return { b64, mime, name };
}

describe("handleImageGenerationCore (edit)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("forwards a Step Plan edit as multipart to /images/edits", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1752565891,
          data: [{ url: "https://res.stepfun.com/image_gen/20250715/sample.png", finish_reason: "success", seed: 1 }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "make it sunset", images: [makeImage()], seed: 1, steps: 8, cfg: 1.5, response_format: "url" },
      modelInfo: { provider: "step-plan", model: "step-image-edit-2" },
      credentials: { apiKey: "test-key" },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.stepfun.com/step_plan/v1/images/edits",
      expect.objectContaining({ method: "POST" })
    );

    const [callUrl, callInit] = global.fetch.mock.calls[0];
    expect(callUrl).toBe("https://api.stepfun.com/step_plan/v1/images/edits");
    expect(callInit.headers).not.toHaveProperty("Content-Type");
    expect(callInit.headers.Authorization).toBe("Bearer test-key");
    expect(callInit.body).toBeInstanceOf(FormData);

    const fd = callInit.body;
    expect(fd.get("model")).toBe("step-image-edit-2");
    expect(fd.get("prompt")).toBe("make it sunset");
    expect(fd.get("seed")).toBe("1");
    expect(fd.get("steps")).toBe("8");
    expect(fd.get("cfg_scale")).toBe("1.5");
    expect(fd.get("response_format")).toBe("url");
    const imagePart = fd.get("image");
    expect(imagePart.name).toBe("input.png");
    expect(imagePart.type).toBe("image/png");

    const responseBody = await result.response.json();
    expect(responseBody.data[0].url).toContain("res.stepfun.com");
  });

  it("rejects Step Plan edits with more than one input image", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "change it", images: [makeImage(), makeImage()] },
      modelInfo: { provider: "step-plan", model: "step-image-edit-2" },
      credentials: { apiKey: "test-key" },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("exactly one input image");
    expect(result.shouldFallback).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends Gemini edit images as inlineData parts", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "edited" }, { inlineData: { mimeType: "image/png", data: "ZWRpdGVkLWltYWdl" } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "add a hat", images: [makeImage("aW5wdXQ=", "image/jpeg", "cat.jpg")] },
      modelInfo: { provider: "gemini", model: "gemini-2.5-flash-image" },
      credentials: { apiKey: "google-key" },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(true);
    const [callUrl, callInit] = global.fetch.mock.calls[0];
    expect(callUrl).toContain("gemini-2.5-flash-image:generateContent");
    expect(callUrl).toContain("key=google-key");

    const sent = JSON.parse(callInit.body);
    expect(sent.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "aW5wdXQ=" },
    });
    expect(sent.contents[0].parts[1]).toEqual({ text: "add a hat" });
    expect(sent.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("ZWRpdGVkLWltYWdl");
  });

  it("forwards OpenAI-compatible edits to the upstream /images/edits endpoint", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ created: 1, data: [{ b64_json: "ZWRpdGVk" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "remove the person",
        images: [makeImage("aW1nMQ==", "image/png", "one.png"), makeImage("aW1nMg==", "image/webp", "two.webp")],
        mask: makeImage("bWFzaw==", "image/png", "mask.png"),
        n: 2,
        size: "1024x1024",
        response_format: "b64_json",
      },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "openai-key" },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(true);
    const [callUrl, callInit] = global.fetch.mock.calls[0];
    expect(callUrl).toBe("https://api.openai.com/v1/images/edits");
    expect(callInit.headers).not.toHaveProperty("Content-Type");

    const fd = callInit.body;
    expect(fd.getAll("image")).toHaveLength(2);
    expect(fd.get("model")).toBe("gpt-image-1");
    expect(fd.get("prompt")).toBe("remove the person");
    expect(fd.get("n")).toBe("2");
    expect(fd.get("size")).toBe("1024x1024");
    expect(fd.get("response_format")).toBe("b64_json");
    expect(fd.get("mask").name).toBe("mask.png");
  });

  it("respects the bodyFields whitelist for OpenAI-compatible edits", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ created: 1, data: [{ url: "https://example.com/out.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "edit this", images: [makeImage()], n: 3, size: "1792x1024" },
      modelInfo: { provider: "xai", model: "grok-image-1" },
      credentials: { apiKey: "xai-key" },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(true);
    const [, callInit] = global.fetch.mock.calls[0];
    const fd = callInit.body;
    expect(fd.get("n")).toBe("3");
    expect(fd.get("size")).toBeNull();
  });

  it("rejects unsupported providers before any upstream call", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "edit this", images: [makeImage()] },
      modelInfo: { provider: "sdwebui", model: "sd-model" },
      credentials: null,
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support image editing");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not advertise file editing for NanoBanana", () => {
    expect(getCapabilitiesForModel("nanobanana", "nanobanana-flash").imageEdit).toBe(false);
  });

  it.each([
    ["gemini", "gemini-2.5-flash-image", { apiKey: "google-key" }],
    ["step-plan", "step-image-edit-2", { apiKey: "step-key" }],
    ["codex", "gpt-5.2-codex-image", { accessToken: "codex-key" }],
  ])("rejects masks that %s cannot preserve", async (provider, model, credentials) => {
    const result = await handleImageGenerationCore({
      body: { prompt: "edit this", images: [makeImage()], mask: makeImage("bWFzaw==") },
      modelInfo: { provider, model },
      credentials,
      operation: "edit",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support image edit masks");
    expect(result.shouldFallback).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("requires an image for edit operations", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "edit this" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "key" },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: image");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps edit timeouts to 504", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    global.fetch.mockRejectedValueOnce(timeoutError);

    const result = await handleImageGenerationCore({
      body: { prompt: "edit this", images: [makeImage()] },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "key" },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toContain("504");
  });

  it("passes Codex edits through with data-URL image references", async () => {
    const sse =
      "event: response.output_item.done\n" +
      'data: {"item":{"type":"image_generation_call","result":"ZWRpdGVk"}}\n\n';
    global.fetch.mockResolvedValueOnce(new Response(sse, { status: 200 }));

    const result = await handleImageGenerationCore({
      body: { prompt: "paint the sky", images: [makeImage("aW5wdXQ=", "image/png", "sky.png")] },
      modelInfo: { provider: "codex", model: "gpt-5.2-codex-image" },
      credentials: { accessToken: "codex-token", providerSpecificData: { chatgptAccountId: "acc-1" } },
      log: null,
      operation: "edit",
    });

    expect(result.success).toBe(true);
    const [callUrl, callInit] = global.fetch.mock.calls[0];
    expect(callUrl).toContain("chatgpt.com/backend-api/codex/responses");
    const sent = JSON.parse(callInit.body);
    const imageUrls = sent.input[0].content.filter((c) => c.type === "input_image").map((c) => c.image_url);
    expect(imageUrls).toContain("data:image/png;base64,aW5wdXQ=");
    expect(sent.tools[0].type).toBe("image_generation");

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("ZWRpdGVk");
  });

  it("keeps generation behavior unchanged (no edit methods required)", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ created: 1, data: [{ url: "https://example.com/gen.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "a cat", n: 1, size: "1024x1024" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const [callUrl] = global.fetch.mock.calls[0];
    expect(callUrl).toBe("https://api.openai.com/v1/images/generations");
  });
});
