import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getComboByName: vi.fn(), getComboById: vi.fn(), getCombos: vi.fn(),
  createCombo: vi.fn(), updateCombo: vi.fn(), deleteCombo: vi.fn(),
}));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

const { POST } = await import("@/app/api/combos/route.js");
const { PUT } = await import("@/app/api/combos/[id]/route.js");
const context = { params: Promise.resolve({ id: "combo-1" }) };
const request = (body) => new Request("http://localhost/api/combos", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getComboByName.mockResolvedValue(null);
  mocks.getComboById.mockResolvedValue({ id: "combo-1", name: "vip" });
  mocks.createCombo.mockImplementation(async (data) => ({ id: "combo-1", ...data }));
  mocks.updateCombo.mockImplementation(async (id, data) => ({ id, name: "vip", ...data }));
});

describe("Combo properties API", () => {
  it("stores validated properties when creating a combo", async () => {
    const capabilities = { contextWindow: 1000000, vision: false, thinkingLevels: ["low", "high", "high"] };
    const response = await POST(request({ name: "vip", models: ["cx/gpt-5.6-sol"], capabilities }));
    expect(response.status).toBe(201);
    expect((await response.json()).capabilities).toEqual({ ...capabilities, thinkingLevels: ["low", "high"] });
  });

  it("accepts a properties-only update and an explicit reset", async () => {
    expect((await PUT(request({ capabilities: { maxOutput: 32000 } }), context)).status).toBe(200);
    expect(mocks.updateCombo).toHaveBeenCalledWith("combo-1", { capabilities: { maxOutput: 32000 } });
    expect((await PUT(request({ capabilities: null }), context)).status).toBe(200);
    expect(mocks.updateCombo).toHaveBeenLastCalledWith("combo-1", { capabilities: {} });
  });

  it("does not replace properties when editing members only", async () => {
    await PUT(request({ models: ["cx/gpt-6-astra"] }), context);
    expect(mocks.updateCombo).toHaveBeenCalledWith("combo-1", { models: ["cx/gpt-6-astra"] });
  });

  it.each([{ contextWindow: -1 }, { audioInput: "yes" }, { thinkingLevels: ["invalid"] }])(
    "returns 400 on invalid metadata without writing: %j", async (capabilities) => {
      expect((await POST(request({ name: "vip", capabilities }))).status).toBe(400);
      expect((await PUT(request({ capabilities }), context)).status).toBe(400);
      expect(mocks.createCombo).not.toHaveBeenCalled();
      expect(mocks.updateCombo).not.toHaveBeenCalled();
    },
  );
});
