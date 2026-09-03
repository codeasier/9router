/**
 * Unit tests for image generation handler
 *
 * Covers:
 *  - OpenAI-compatible format (openai, minimax, openrouter)
 *  - Gemini format (generateContent API)
 *  - Provider-specific formats (nanobanana, sdwebui)
 *  - Response normalization to OpenAI format
 *  - Error handling (missing prompt, invalid model)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const originalFetch = global.fetch;

describe("handleImageGenerationCore", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("validates required prompt field", async () => {
    const result = await handleImageGenerationCore({
      body: { model: "openai/dall-e-3" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: prompt");
  });

  it("rejects unsupported provider", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "unknown-provider", model: "test" },
      credentials: null,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support image generation");
  });

  it("generates image with OpenAI format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/image.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A cute cat", n: 1, size: "1024x1024" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
        body: expect.stringContaining('"prompt":"A cute cat"'),
      })
    );

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(1);
    expect(responseBody.data[0].url).toBe("https://example.com/image.png");
  });

  it("generates image with Gemini format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "Generated image" },
                  { inlineData: { data: "base64imagedata" } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A sunset" },
      modelInfo: { provider: "gemini", model: "gemini-image-preview" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"responseModalities":["TEXT","IMAGE"]'),
      })
    );

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(1);
    expect(responseBody.data[0].b64_json).toBe("base64imagedata");
  });

  it("generates image with Minimax format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/minimax.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A mountain", size: "1024x1024" },
      modelInfo: { provider: "minimax", model: "minimax-image-01" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      })
    );
  });

  it("generates image with NanoBanana format", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 200, data: { taskId: "task-123" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              successFlag: 1,
              response: { resultImageUrl: "https://example.com/nanobanana.png" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const pending = handleImageGenerationCore({
      body: { prompt: "A robot", n: 2, size: "1024x1792" },
      modelInfo: { provider: "nanobanana", model: "nanobanana-flash" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(result.success).toBe(true);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.type).toBe("TEXTTOIAMGE");
    expect(requestBody.numImages).toBe(2);
    expect(requestBody.image_size).toBe("9:16");
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.nanobananaapi.ai/api/v1/nanobanana/record-info?taskId=task-123",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      })
    );

    const responseBody = await result.response.json();
    expect(responseBody.data[0].url).toBe("https://example.com/nanobanana.png");
  });

  it("generates image with SD WebUI format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ images: ["base64sdwebui1", "base64sdwebui2"] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A forest", size: "768x768", n: 2 },
      modelInfo: { provider: "sdwebui", model: "sdxl-base-1.0" },
      credentials: null,
      log: null,
    });

    expect(result.success).toBe(true);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.width).toBe(768);
    expect(requestBody.height).toBe(768);
    expect(requestBody.batch_size).toBe(2);

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(2);
  });

  it("handles OpenRouter with HTTP-Referer header", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/or.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A city" },
      modelInfo: { provider: "openrouter", model: "openai/dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/images/generations",
      expect.objectContaining({
        headers: expect.objectContaining({
          "HTTP-Referer": "https://endpoint-proxy.local",
          "X-Title": "Endpoint Proxy",
        }),
      })
    );
  });

  it("handles Vercel AI Gateway image generation as OpenAI-compatible", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/vercel-image.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A watercolor castle", n: 1, size: "1024x1024" },
      modelInfo: { provider: "vercel-ai-gateway", model: "openai/gpt-image-1" },
      credentials: { apiKey: "vag-test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer vag-test-key",
        }),
        body: expect.stringContaining('"model":"openai/gpt-image-1"'),
      })
    );
  });

  it("handles HuggingFace binary response", async () => {
    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    global.fetch.mockResolvedValueOnce(
      new Response(imageBuffer, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A tree" },
      modelInfo: { provider: "huggingface", model: "black-forest-labs/FLUX.1-schnell" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBeTruthy();
  });

  it("generates image with Codex gpt-5.5-image using current Codex version header", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        [
          "event: response.output_item.done",
          'data: {"item":{"type":"image_generation_call","result":"base64codeximage"}}',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "A green square",
        size: "1024x1024",
        output_format: "png",
      },
      modelInfo: { provider: "codex", model: "gpt-5.5-image" },
      credentials: {
        accessToken: "codex-token",
        providerSpecificData: { chatgptAccountId: "account-123" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer codex-token",
          "chatgpt-account-id": "account-123",
          version: "0.136.0",
        }),
      })
    );

    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.model).toBe("gpt-5.5");
    expect(requestBody.tools).toEqual([
      { type: "image_generation", output_format: "png", size: "1024x1024" },
    ]);

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("base64codeximage");
  });

  it("generates image with Cloudflare Workers AI JSON response", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { image: "base64cloudflare" },
          success: true,
          errors: [],
          messages: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A lighthouse", size: "1024x1536" },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/leonardo/lucid-origin" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/leonardo/lucid-origin",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer cf-token",
        }),
      })
    );

    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.prompt).toBe("A lighthouse");
    expect(requestBody.width).toBe(1024);
    expect(requestBody.height).toBe(1536);

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("base64cloudflare");
  });

  it("uses multipart form data for Cloudflare FLUX.2 models", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { image: "base64flux2" },
          success: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A mountain lake", size: "1792x1024", steps: 4 },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/black-forest-labs/flux-2-klein-9b" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);

    const fetchCall = global.fetch.mock.calls[0];
    expect(fetchCall[1].headers).not.toHaveProperty("Content-Type");
    expect(fetchCall[1].body).toBeInstanceOf(FormData);
    expect(fetchCall[1].body.get("prompt")).toBe("A mountain lake");
    expect(fetchCall[1].body.get("width")).toBe("1792");
    expect(fetchCall[1].body.get("height")).toBe("1024");
    expect(fetchCall[1].body.get("steps")).toBe("4");
  });

  it("resolves Cloudflare img2img and inpainting URL inputs before sending", async () => {
    global.fetch
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "Content-Type": "image/png" } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { image: "base64inpaint" }, success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "Change to a lion",
        image: "https://example.com/source.png",
        mask_image: "https://example.com/mask.png",
        size: "512x512",
      },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/runwayml/stable-diffusion-v1-5-inpainting" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenNthCalledWith(1, "https://example.com/source.png");
    expect(global.fetch).toHaveBeenNthCalledWith(2, "https://example.com/mask.png");

    const providerCall = global.fetch.mock.calls[2];
    expect(providerCall[0]).toBe("https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/runwayml/stable-diffusion-v1-5-inpainting");
    const requestBody = JSON.parse(providerCall[1].body);
    expect(requestBody.image).toEqual([1, 2, 3]);
    expect(requestBody.image_b64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(requestBody.mask).toEqual([4, 5, 6]);
    expect(requestBody.mask_image).toEqual([4, 5, 6]);
    expect(requestBody.mask_b64).toBe(Buffer.from([4, 5, 6]).toString("base64"));
  });

  it("handles provider error responses", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded" } }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toContain("Rate limit exceeded");
  });

  it("handles network errors", async () => {
    global.fetch.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Network timeout");
  });

  it("calls onRequestSuccess callback on success", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/success.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
      onRequestSuccess,
    });

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  describe("Step Plan", () => {
    const modelInfo = { provider: "step-plan", model: "step-image-edit-2" };
    const credentials = { apiKey: "step-key" };
    const successBody = {
      id: "image-request-1",
      created: 1234567890,
      data: [{ url: "https://example.com/step.png", finish_reason: "success", seed: 0 }],
    };

    async function generate(body, options = {}) {
      return handleImageGenerationCore({
        body: { prompt: "A paper lantern", ...body },
        modelInfo,
        credentials: options.credentials || credentials,
        binaryOutput: options.binaryOutput,
        log: null,
      });
    }

    it("uses the fixed endpoint, Bearer API key, and minimal defaults", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(successBody), { status: 200 })
      );

      const result = await generate({
        size: "auto",
        quality: "hd",
        style: "vivid",
        background: "transparent",
        image_detail: "high",
        output_format: "webp",
      });

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.stepfun.com/step_plan/v1/images/generations",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer step-key",
          },
          body: JSON.stringify({
            model: "step-image-edit-2",
            prompt: "A paper lantern",
            n: 1,
          }),
        }
      );
      expect(await result.response.json()).toEqual(successBody);
    });

    it("accepts accessToken credentials", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(successBody), { status: 200 })
      );

      await generate({}, { credentials: { accessToken: "step-token" } });

      expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer step-token");
    });

    it("forwards every supported field and preserves explicit falsey values", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(successBody), { status: 200 })
      );

      await generate({
        n: 1.0,
        size: "768x1360",
        response_format: "b64_json",
        seed: 0,
        steps: 8,
        cfg_scale: 1.5,
        negative_prompt: "",
        text_mode: false,
      });

      expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
        model: "step-image-edit-2",
        prompt: "A paper lantern",
        n: 1,
        size: "768x1360",
        response_format: "b64_json",
        seed: 0,
        steps: 8,
        cfg_scale: 1.5,
        negative_prompt: "",
        text_mode: false,
      });
    });

    it("maps the compatibility cfg field to cfg_scale", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(successBody), { status: 200 })
      );

      const result = await generate({ cfg: 1.5 });

      expect(result.success).toBe(true);
      const request = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(request.cfg_scale).toBe(1.5);
      expect(request).not.toHaveProperty("cfg");
    });

    it.each(["1024x1024", "768x1360", "896x1184", "1360x768", "1184x896"])(
      "forwards documented size %s unchanged",
      async (size) => {
        global.fetch.mockResolvedValueOnce(
          new Response(JSON.stringify(successBody), { status: 200 })
        );

        await generate({ size });

        expect(JSON.parse(global.fetch.mock.calls[0][1].body).size).toBe(size);
      }
    );

    it("accepts inclusive upper validation boundaries", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(successBody), { status: 200 })
      );

      const prompt = "😀".repeat(512);
      const negativePrompt = "界".repeat(512);
      const result = await generate({
        prompt,
        seed: 2147483647,
        steps: 50,
        cfg_scale: 10,
        negative_prompt: negativePrompt,
        text_mode: true,
        response_format: "url",
      });

      expect(result.success).toBe(true);
      expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
        prompt,
        seed: 2147483647,
        steps: 50,
        cfg_scale: 10,
        negative_prompt: negativePrompt,
        text_mode: true,
        response_format: "url",
      });
    });

    it("accepts inclusive lower numeric boundaries", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(successBody), { status: 200 })
      );

      const result = await generate({ seed: 0, steps: 1, cfg_scale: 1 });

      expect(result.success).toBe(true);
      expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
        seed: 0,
        steps: 1,
        cfg_scale: 1,
      });
    });

    it.each([
      ["missing prompt", { prompt: "" }],
      ["non-string prompt", { prompt: 42 }],
      ["prompt over 512 code points", { prompt: "😀".repeat(513) }],
      ["null count", { n: null }],
      ["string count", { n: "1" }],
      ["fractional count", { n: 1.1 }],
      ["zero count", { n: 0 }],
      ["count above one", { n: 2 }],
      ["unknown size", { size: "1536x1024" }],
      ["non-string size", { size: 1024 }],
      ["unknown response format", { response_format: "binary" }],
      ["non-string response format", { response_format: false }],
      ["negative seed", { seed: -1 }],
      ["seed above maximum", { seed: 2147483648 }],
      ["fractional seed", { seed: 0.5 }],
      ["string seed", { seed: "0" }],
      ["steps below minimum", { steps: 0 }],
      ["steps above maximum", { steps: 51 }],
      ["fractional steps", { steps: 1.5 }],
      ["string steps", { steps: "8" }],
      ["cfg scale below minimum", { cfg_scale: 0.9 }],
      ["cfg scale above maximum", { cfg_scale: 10.1 }],
      ["string cfg scale", { cfg_scale: "1.0" }],
      ["non-finite cfg scale", { cfg_scale: Infinity }],
      ["non-string negative prompt", { negative_prompt: false }],
      ["negative prompt over 512 code points", { negative_prompt: "界".repeat(513) }],
      ["non-boolean text mode", { text_mode: "false" }],
    ])("rejects %s locally without fetch", async (_label, body) => {
      const result = await generate(body);

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each([
      [
        "URL",
        {
          id: "url-id",
          created: 100,
          data: [{ url: "https://example.com/step.png", finish_reason: "success", seed: 17 }],
        },
      ],
      [
        "base64",
        {
          id: "b64-id",
          created: 101,
          data: [{ b64_json: "AQID", finish_reason: "success", seed: 18 }],
        },
      ],
    ])("preserves the complete %s response by identity", async (_label, upstreamBody) => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamBody), { status: 200 })
      );

      const result = await generate({});

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual(upstreamBody);
    });

    it("converts a Step Plan base64 result to binary", async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ created: 1, data: [{ b64_json: "AQID" }] }), { status: 200 })
      );

      const result = await generate({}, { binaryOutput: true });

      expect(result.success).toBe(true);
      expect(result.response.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("fetches and converts a Step Plan URL result to binary", async () => {
      global.fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ created: 1, data: [{ url: "https://example.com/step.png" }] }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "Content-Type": "image/png" } })
        );

      const result = await generate({}, { binaryOutput: true });

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenNthCalledWith(2, "https://example.com/step.png");
      expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    });

    it("returns 502 for an invalid JSON success body", async () => {
      global.fetch.mockResolvedValueOnce(new Response("not json", { status: 200 }));

      const result = await generate({});

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
    });

    it("does not impose new structural validation on a valid JSON success body", async () => {
      const upstreamBody = { status: "accepted" };
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamBody), { status: 200 })
      );

      const result = await generate({});

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual(upstreamBody);
    });

    it.each([
      [401, "Invalid API key"],
      [403, "Forbidden"],
      [429, "Rate limit exceeded"],
      [500, "Step Plan unavailable"],
    ])("preserves upstream HTTP %s failures", async (status, message) => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message } }), { status })
      );

      const result = await generate({});

      expect(result.success).toBe(false);
      expect(result.status).toBe(status);
      expect(result.error).toContain(message);
    });

    it("uses existing network failure behavior", async () => {
      global.fetch.mockRejectedValueOnce(new Error("Step Plan timeout"));

      const result = await generate({});

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toContain("Step Plan timeout");
    });
  });
});
