import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same offline seams as search-budget-usage / fetch-success-clears-account /
// image-edit-handler: mock persistence and upstream cores, not the policy engine.
const mocks = vi.hoisted(() => ({
  policyRecord: null,
  getProviderCredentials: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  getComboModelsFromData: vi.fn(),
  handleComboChat: vi.fn(),
  assertPublicUrlResolved: vi.fn(),
  embeddingsCore: vi.fn(),
  ttsCore: vi.fn(),
  sttCore: vi.fn(),
  imageCore: vi.fn(),
  searchCore: vi.fn(),
  fetchCore: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: async () => true,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getApiKeyByKey: async () => mocks.policyRecord,
  getCombos: async () => [],
  getCustomModels: async () => [],
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: mocks.assertPublicUrlResolved }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: mocks.handleComboChat,
  getComboModelsFromData: mocks.getComboModelsFromData,
}));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.embeddingsCore }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.ttsCore }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.sttCore }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.imageCore }));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.searchCore }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.fetchCore }));

import { handleEmbeddings } from "@/sse/handlers/embeddings.js";
import { handleTts } from "@/sse/handlers/tts.js";
import { handleStt } from "@/sse/handlers/stt.js";
import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";
import { handleImageEdit } from "@/sse/handlers/imageEdit.js";
import { handleSearch } from "@/sse/handlers/search.js";
import { handleFetch } from "@/sse/handlers/fetch.js";
import { _resetKeyPolicyState, _setBudgetQuery } from "@/sse/services/keyPolicy.js";
import { IMAGE_EDIT_LIMITS } from "open-sse/config/runtimeConfig.js";

const KEY = "client-key";
const inflight = () => global._keyPolicyState.inflight.get(KEY) || 0;
const pngFile = () => new File([new Uint8Array([1, 2, 3])], "input.png", { type: "image/png" });

function jsonRequest(path, body) {
  return new Request(`http://localhost${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

function multipartRequest(path, defaults, overrides = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value !== null && value !== undefined) form.append(name, value);
  }
  return new Request(`http://localhost${path}`, { method: "POST", body: form });
}

const endpoints = [
  {
    name: "embeddings", handle: handleEmbeddings, core: mocks.embeddingsCore,
    request: (fields = {}) => jsonRequest("/v1/embeddings", { model: "openai/embedding", input: "hello", ...fields }),
    invalid: [{ model: null }, { input: null }],
  },
  {
    name: "tts", handle: handleTts, core: mocks.ttsCore, combo: true,
    request: (fields = {}) => jsonRequest("/v1/audio/speech", { model: "openai/voice", input: "hello", ...fields }),
    invalid: [{ model: null }, { input: null }],
  },
  {
    name: "stt", handle: handleStt, core: mocks.sttCore,
    request: (fields = {}) => multipartRequest("/v1/audio/transcriptions", {
      model: "openai/whisper", file: new File(["audio"], "audio.wav", { type: "audio/wav" }),
    }, fields),
    invalid: [{ model: null }, { file: null }],
  },
  {
    name: "image generation", handle: handleImageGeneration, core: mocks.imageCore, combo: true, image: true,
    request: (fields = {}) => jsonRequest("/v1/images/generations", { model: "openai/image", prompt: "sunrise", ...fields }),
    invalid: [{ model: null }, { prompt: null }],
  },
  {
    name: "image edit", handle: handleImageEdit, core: mocks.imageCore, combo: true, image: true,
    request: (fields = {}) => multipartRequest("/v1/images/edits", {
      model: "openai/image", prompt: "sunrise", image: pngFile(),
    }, fields),
    invalid: [{ model: null }, { prompt: null }, { image: null }, { n: "not-an-integer" }, {
      image: new File(["invalid"], "input.txt", { type: "text/plain" }),
    }],
  },
  {
    name: "search", handle: handleSearch, core: mocks.searchCore, combo: true,
    request: (fields = {}) => jsonRequest("/v1/search", { provider: "tavily", query: "release", ...fields }),
    invalid: [{ provider: null }, { query: " " }],
  },
  {
    name: "fetch", handle: handleFetch, core: mocks.fetchCore, combo: true,
    request: (fields = {}) => jsonRequest("/v1/web/fetch", { provider: "jina-reader", url: "https://example.com/article", ...fields }),
    invalid: [{ provider: null }, { url: null }, { url: "not-a-url" }],
  },
];
const responseEndpoints = endpoints.filter(({ name }) => name !== "fetch");

beforeEach(() => {
  vi.resetAllMocks();
  _resetKeyPolicyState();
  _setBudgetQuery(async () => 0);
  mocks.policyRecord = { policy: { maxConcurrent: 1 } };
  mocks.getProviderCredentials.mockResolvedValue({
    apiKey: "provider-secret", connectionId: "connection", connectionName: "Test",
  });
  mocks.getModelInfo.mockImplementation(async (value) => {
    const [provider, model] = value.split("/");
    return { provider, model };
  });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getComboModelsFromData.mockReturnValue(null);
  mocks.handleComboChat.mockImplementation(async ({ body, models, handleSingleModel }) => handleSingleModel(body, models[0]));
  mocks.assertPublicUrlResolved.mockResolvedValue(undefined);
  mocks.saveRequestUsage.mockResolvedValue(true);
  for (const core of [mocks.embeddingsCore, mocks.ttsCore, mocks.sttCore, mocks.imageCore, mocks.searchCore, mocks.fetchCore]) {
    // Fresh Response for each invocation: never reuse a locked/consumed body.
    core.mockImplementation(async () => ({
      success: true, response: Response.json({ ok: true }), data: { provider: "tavily" },
    }));
  }
});

afterEach(() => {
  _resetKeyPolicyState();
  _setBudgetQuery(null);
});

describe.each(endpoints)("$name key-policy lifecycle", (endpoint) => {
  it.each(endpoint.invalid)("releases an unconsumed validation response for %j", async (fields) => {
    const response = await endpoint.handle(endpoint.request(fields));
    expect(response.status).toBe(400);
    // No response.text()/cancel before this assertion: errors must not retain a
    // slot just because the client ignores the error body.
    expect(inflight()).toBe(0);
    expect(endpoint.core).not.toHaveBeenCalled();
    const retry = await endpoint.handle(endpoint.request());
    expect(retry.status).toBe(200);
    await retry.text();
    expect(inflight()).toBe(0);
    await response.body.cancel();
  });

  it("releases when the upstream core throws", async () => {
    const error = new Error("offline upstream failed");
    endpoint.core.mockRejectedValueOnce(error);
    await expect(endpoint.handle(endpoint.request())).rejects.toBe(error);
    expect(inflight()).toBe(0);
    const retry = await endpoint.handle(endpoint.request());
    expect(retry.status).toBe(200);
    await retry.text();
    expect(inflight()).toBe(0);
  });

  it("holds one slot until the successful response is consumed", async () => {
    const response = await endpoint.handle(endpoint.request());
    expect(response.status).toBe(200);
    expect(inflight()).toBe(1);
    const blocked = await endpoint.handle(endpoint.request());
    expect(blocked.status).toBe(429);
    expect(endpoint.core).toHaveBeenCalledTimes(1);
    expect(inflight()).toBe(1);
    await response.text();
    expect(inflight()).toBe(0);
    const retry = await endpoint.handle(endpoint.request());
    expect(retry.status).toBe(200);
    await retry.text();
    expect(inflight()).toBe(0);
  });

  it("releases an upstream error response without waiting for its body", async () => {
    endpoint.core.mockResolvedValueOnce({
      success: false, status: 502, error: "offline upstream failed",
      response: Response.json({ error: "offline upstream failed" }, { status: 502 }),
    });
    const response = await endpoint.handle(endpoint.request());
    expect(response.status).toBe(502);
    expect(inflight()).toBe(0);
    await response.body.cancel();
  });
});

describe.each(responseEndpoints)("$name upstream response lifecycle", (endpoint) => {
  it("releases immediately for a response without a body", async () => {
    endpoint.core.mockResolvedValueOnce({ success: true, response: new Response(null, { status: 204 }) });
    const response = await endpoint.handle(endpoint.request());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(inflight()).toBe(0);
  });

  it("holds an open stream, then releases exactly once on client cancellation", async () => {
    const cancel = vi.fn();
    endpoint.core.mockResolvedValueOnce({
      success: true,
      response: new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); },
        cancel,
      }), { headers: { "Content-Type": "text/event-stream", "X-Upstream": "preserved" } }),
    });
    const response = await endpoint.handle(endpoint.request());
    expect(response.headers.get("X-Upstream")).toBe("preserved");
    const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(inflight()).toBe(1);
    await reader.cancel("disconnect");
    expect(cancel).toHaveBeenCalledWith("disconnect");
    expect(inflight()).toBe(0);
    // A second cancellation must not release a newer request's slot.
    const next = await endpoint.handle(endpoint.request());
    expect(inflight()).toBe(1);
    await reader.cancel("again");
    expect(inflight()).toBe(1);
    await next.text();
    expect(inflight()).toBe(0);
  });

  it("releases when the upstream stream errors", async () => {
    let controller;
    endpoint.core.mockResolvedValueOnce({
      success: true,
      response: new Response(new ReadableStream({ start(value) { controller = value; } })),
    });
    const response = await endpoint.handle(endpoint.request());
    expect(inflight()).toBe(1);
    const consumed = response.text();
    controller.error(new Error("offline stream failed"));
    await expect(consumed).rejects.toThrow("offline stream failed");
    expect(inflight()).toBe(0);
  });
});

describe.each(endpoints.filter(({ combo }) => combo))("$name combo lifecycle", (endpoint) => {
  it("uses one slot around combo execution and releases on failure", async () => {
    mocks.getComboModels.mockResolvedValue(["openai/test"]);
    mocks.getComboModelsFromData.mockReturnValue([endpoint.name === "search" ? "tavily" : "jina-reader"]);
    const error = new Error("offline combo failed");
    mocks.handleComboChat.mockImplementationOnce(async () => {
      expect(inflight()).toBe(1);
      throw error;
    });
    await expect(endpoint.handle(endpoint.request())).rejects.toBe(error);
    expect(mocks.handleComboChat).toHaveBeenCalledTimes(1);
    expect(inflight()).toBe(0);
    const retry = await endpoint.handle(endpoint.request());
    expect(retry.status).toBe(200);
    expect(inflight()).toBe(1);
    await retry.text();
    expect(inflight()).toBe(0);
  });
});

describe.each(endpoints.filter(({ image }) => image))("$name budget exemption", (endpoint) => {
  it("skips exhausted budgets and breakers, but still enforces concurrency", async () => {
    mocks.policyRecord = { policy: {
      maxConcurrent: 1, budgets: [{ provider: "*", limitUsd: 1, period: "day" }],
    } };
    global._keyPolicyState.breaker.set(KEY, { untilMs: Date.now() + 60_000, reason: "exhausted" });
    _setBudgetQuery(async () => 50);
    const response = await endpoint.handle(endpoint.request());
    expect(response.status).toBe(200);
    expect(inflight()).toBe(1);
    expect((await endpoint.handle(endpoint.request())).status).toBe(429);
    await response.text();
    expect(inflight()).toBe(0);
  });
});

it("releases image-edit's slot after malformed multipart and content-length early returns", async () => {
  const malformed = new Request("http://localhost/v1/images/edits", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  expect((await handleImageEdit(malformed)).status).toBe(400);
  expect(inflight()).toBe(0);
  const oversized = new Request("http://localhost/v1/images/edits", {
    method: "POST", headers: { "Content-Length": String(IMAGE_EDIT_LIMITS.maxTotalBytes + 64 * 1024 + 1) }, body: "invalid",
  });
  expect((await handleImageEdit(oversized)).status).toBe(400);
  expect(inflight()).toBe(0);
  expect(mocks.imageCore).not.toHaveBeenCalled();
});

it("releases fetch's slot after the SSRF guard rejects a target", async () => {
  mocks.assertPublicUrlResolved.mockRejectedValueOnce(new Error("Blocked private target"));
  const response = await handleFetch(endpoints.find(({ name }) => name === "fetch").request());
  expect(response.status).toBe(400);
  expect(inflight()).toBe(0);
  expect(mocks.fetchCore).not.toHaveBeenCalled();
  await response.body.cancel();
});
