import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { requireApiKey: true },
  valid: true,
  combo: vi.fn(),
  bypass: vi.fn(),
  upstream: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings,
  getApiKeyByKey: async () => ({ policy: { maxConcurrent: 1 } }),
  getCustomModels: async () => [],
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (r) => r.headers.get("authorization")?.replace("Bearer ", ""),
  isValidApiKey: async () => mocks.valid,
  getProviderCredentials: vi.fn(), markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({ getComboModels: mocks.combo, getModelInfo: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.bypass }));
vi.mock("open-sse/services/combo.js", () => ({
  detectRequiredCapabilities: () => new Set(), handleComboChat: mocks.upstream, handleFusionChat: mocks.upstream,
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn, getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(), checkAndRefreshToken: vi.fn() }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

const policy = await import("@/sse/services/keyPolicy.js");
const KEY = "sk-lifecycle-test";
const routes = [
  ["responses", (await import("@/app/api/v1/responses/route.js")).POST],
  ["chat/completions", (await import("@/app/api/v1/chat/completions/route.js")).POST],
  ["messages", (await import("@/app/api/v1/messages/route.js")).POST],
];
function request(endpoint, body) {
  return new Request(`http://localhost/v1/${endpoint}`, {
    method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const inflight = async () => (await policy.getKeyPolicyStatus(KEY)).inflight;

beforeEach(() => {
  vi.clearAllMocks();
  policy._resetKeyPolicyState();
  policy._setBudgetQuery(async () => 0);
  mocks.settings = { requireApiKey: true };
  mocks.valid = true;
  mocks.combo.mockImplementation(async (model) => {
    if (model.includes("/")) return null;
    return ["codex/test"];
  });
  mocks.bypass.mockReturnValue(null);
  mocks.upstream.mockResolvedValue(new Response(null, { status: 204 }));
});

describe.each(routes)("%s key-policy lifecycle", (endpoint, POST) => {
  it.each([
    ["missing model", {}], ["object model", { model: { provider: "codex" } }],
    ["array model", { model: ["codex/test"] }], ["numeric model", { model: 1 }],
    ["empty model", { model: "" }], ["whitespace model", { model: "  " }],
    ["null body", null], ["array body", []], ["string body", "test"],
  ])("returns 400 without acquiring a slot: %s", async (_label, body) => {
    const response = await POST(request(endpoint, body));
    expect(response.status).toBe(400);
    expect(await inflight()).toBe(0);
    expect(mocks.combo).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
    expect((await POST(request(endpoint, { model: "combo" }))).status).toBe(204);
  });

  it("authenticates before reporting invalid model/body", async () => {
    mocks.valid = false;
    const response = await POST(request(endpoint, null));
    expect(response.status).toBe(401);
    expect(await inflight()).toBe(0);
  });

  it("releases immediately when model resolution throws before wrapping", async () => {
    mocks.combo.mockRejectedValueOnce(new Error("resolution failed"));
    await expect(POST(request(endpoint, { model: "combo" }))).rejects.toThrow("resolution failed");
    expect(await inflight()).toBe(0);
    expect((await POST(request(endpoint, { model: "combo" }))).status).toBe(204);
  });

  it("releases immediately when the selected handler throws", async () => {
    mocks.upstream.mockRejectedValueOnce(new Error("upstream failed"));
    await expect(POST(request(endpoint, { model: "combo" }))).rejects.toThrow("upstream failed");
    expect(await inflight()).toBe(0);
  });

  it("holds a streamed response slot until body cancel", async () => {
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } }), {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await POST(request(endpoint, { model: "combo" }));
    expect(await inflight()).toBe(1);
    const rejected = await POST(request(endpoint, { model: "combo" }));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    await response.body.cancel();
    expect(await inflight()).toBe(0);
  });
});
