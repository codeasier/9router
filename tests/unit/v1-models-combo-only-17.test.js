import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getCombos: vi.fn(),
  getProviderConnections: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
}));

const disabledMocks = vi.hoisted(() => ({
  getDisabledModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/disabledModelsDb", () => disabledMocks);

const { GET, buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const compatibleConnection = {
  id: "compat-1",
  provider: "openai-compatible-iflow",
  isActive: true,
  apiKey: "sk-test",
  providerSpecificData: {
    baseUrl: "https://upstream.example/v1",
    prefix: "if",
    enabledModels: ["glm-4.7"],
  },
};

function catalogCombos() {
  return [
    { id: "c-llm", name: "vip", kind: "llm" },
    { id: "c-default", name: "mycodex" },
    { id: "c-image", name: "imagine", kind: "image" },
    { id: "c-search", name: "web", kind: "webSearch" },
    { id: "c-dup", name: "vip", kind: "llm" },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getCombos.mockResolvedValue(catalogCombos());
  dbMocks.getProviderConnections.mockResolvedValue([compatibleConnection]);
  dbMocks.getCustomModels.mockResolvedValue([
    { id: "extra-chat", providerAlias: "if", type: "llm" },
  ]);
  dbMocks.getModelAliases.mockResolvedValue({ shortcut: "if/glm-4.7" });
  disabledMocks.getDisabledModels.mockResolvedValue({});
  global.fetch = vi.fn(async () => {
    throw new Error("GET /v1/models must not live-fetch upstream /models");
  });
});

describe("GET /v1/models combo-only catalog (#17)", () => {
  it("returns only configured LLM combos and skips provider expansion", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      object: "list",
      data: [
        { id: "vip", object: "model", owned_by: "combo" },
        { id: "mycodex", object: "model", owned_by: "combo" },
      ],
    });
    expect(body.data.every((model) => model.owned_by === "combo")).toBe(true);
    expect(dbMocks.getProviderConnections).not.toHaveBeenCalled();
    expect(dbMocks.getCustomModels).not.toHaveBeenCalled();
    expect(dbMocks.getModelAliases).not.toHaveBeenCalled();
    expect(disabledMocks.getDisabledModels).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns an empty list when no LLM combos exist instead of falling back to PROVIDER_MODELS", async () => {
    dbMocks.getCombos.mockResolvedValue([{ id: "c-image", name: "imagine", kind: "image" }]);
    dbMocks.getProviderConnections.mockImplementation(() => {
      throw new Error("GET /v1/models must not load connections");
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ object: "list", data: [] });
  });

  it("keeps GET /v1/models/{kind} expansion available via buildModelsList without combosOnly", async () => {
    const models = await buildModelsList(["llm"]);
    const ids = models.map((model) => model.id);

    expect(ids).toContain("vip");
    expect(ids).toContain("mycodex");
    expect(ids).toContain("if/glm-4.7");
    expect(ids).not.toContain("imagine");
    expect(dbMocks.getProviderConnections).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
