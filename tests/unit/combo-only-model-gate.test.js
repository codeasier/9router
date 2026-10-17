import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { requireApiKey: true, allowComboModelsOnly: false },
  valid: true,
  combos: [],
  combo: vi.fn(),
  bypass: vi.fn(),
  upstream: vi.fn(),
  getCombosError: null,
  internal: false,
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
// Operator identity: dashboard session cookie or this instance's own CLI token.
// Mocked here so the gate's own contract is what these tests pin; the real
// helper is covered by tests/unit/dashboard-guard.test.js.
vi.mock("@/dashboardGuard", () => ({
  isManagementAuthenticated: async () => mocks.internal,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings,
  getApiKeyByKey: async () => null,
  getCustomModels: async () => [],
  getCombos: async () => {
    if (mocks.getCombosError) throw mocks.getCombosError;
    return mocks.combos;
  },
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (r) => r.headers.get("authorization")?.replace("Bearer ", ""),
  isValidApiKey: async () => mocks.valid,
  getProviderCredentials: async () => ({ id: "acc-1", accessToken: "tok", isActive: true, providerSpecificData: {} }),
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.combo,
  getModelInfo: async (model) => ({ provider: "codex", model }),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.bypass }));
vi.mock("open-sse/services/combo.js", () => ({
  detectRequiredCapabilities: () => new Set(), handleComboChat: mocks.upstream, handleFusionChat: mocks.upstream,
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn, getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async () => ({
    success: true,
    response: new Response(null, { status: 204 }),
  })),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

const KEY = "sk-combo-only-test";
const POST = (await import("@/app/api/v1/chat/completions/route.js")).POST;
const { collectComboModelIds } = await import("@/sse/services/modelAllowlist.js");

function request(model) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { requireApiKey: true, allowComboModelsOnly: false };
  mocks.valid = true;
  mocks.getCombosError = null;
  mocks.internal = false;
  mocks.combos = [
    { name: "fast", kind: null, models: ["cx/gpt-5.6-sol"] },
    { name: "deep", kind: "llm", models: ["cx/gpt-6-astra"] },
    { name: "pics", kind: "image", models: ["cx/gpt-image-2.5"] },
  ];
  mocks.combo.mockImplementation(async (model) => {
    if (model.includes("/")) return null;
    return ["codex/test"];
  });
  mocks.bypass.mockReturnValue(null);
  mocks.upstream.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("collectComboModelIds", () => {
  it("keeps LLM and kind-less combos, drops other kinds", () => {
    expect(collectComboModelIds(mocks.combos)).toEqual(["fast", "deep"]);
    expect(collectComboModelIds(mocks.combos, ["image"])).toEqual(["pics"]);
  });

  it("dedupes and drops unnamed combos", () => {
    expect(collectComboModelIds([{ name: "a" }, { name: "a" }, { kind: null }, null])).toEqual(["a"]);
  });
});

describe("allowComboModelsOnly request gate", () => {
  it("allows a published combo and rejects everything else with 404", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    expect((await POST(request("fast"))).status).toBe(204);

    const denied = await POST(request("cx/gpt-5.5"));
    expect(denied.status).toBe(404);
    expect((await denied.json()).error.code).toBe("model_not_found");
  });

  it("rejects non-LLM combos that /v1/models does not publish", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    expect((await POST(request("pics"))).status).toBe(404);
    expect((await POST(request("deep"))).status).toBe(204);
  });

  it("rejects before combo resolution, credential lookup and upstream", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    await POST(request("nope"));
    expect(mocks.combo).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("rejects after authentication, so a bad key still wins", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    mocks.valid = false;
    expect((await POST(request("nope"))).status).toBe(401);
  });

  it("fails open when combos cannot be read", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    mocks.getCombosError = new Error("db down");
    expect((await POST(request("cx/gpt-5.5"))).status).toBe(204);
  });

  it("is off by default — any model string reaches resolution", async () => {
    expect((await POST(request("cx/gpt-5.5"))).status).toBe(204);
    expect(mocks.combo).toHaveBeenCalledWith("cx/gpt-5.5");
  });

  it("rejects every model when no combos exist", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    mocks.combos = [];
    expect((await POST(request("fast"))).status).toBe(404);
  });

  it("lets the operator through, so dashboard model tests survive the policy", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    mocks.internal = true;
    expect((await POST(request("cx/gpt-6.1-sol"))).status).toBe(204);
    // Reached resolution instead of short-circuiting into the 404 gate.
    expect(mocks.combo).toHaveBeenCalledWith("cx/gpt-6.1-sol");
  });

  it("still resolves real models for the operator, not just combo names", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: true };
    mocks.internal = true;
    expect((await POST(request("volceapi/kimi-k3"))).status).toBe(204);
    expect(mocks.combo).toHaveBeenCalledWith("volceapi/kimi-k3");
  });

  it("does not consult the operator identity while the gate is off", async () => {
    mocks.settings = { requireApiKey: true, allowComboModelsOnly: false };
    expect((await POST(request("cx/gpt-5.5"))).status).toBe(204);
  });
});
