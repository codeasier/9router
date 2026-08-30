import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  configure: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => Response.json(body, init) },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(), genSalt: vi.fn(), hash: vi.fn() } }));
vi.mock("@/shared/services/codexResetCreditAutoUse", () => ({
  configureCodexResetCreditAutoUse: mocks.configure,
}));
vi.mock("@/shared/services/quotaAutoPing", () => ({ configureQuotaAutoPing: vi.fn() }));

describe("Codex reset-credit settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSettings.mockImplementation(async (updates) => ({ ...updates }));
  });

  it("persists a normalized threshold and reconfigures the scheduler", async () => {
    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codexResetCreditAutoUseMinutes: 9.6 }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ codexResetCreditAutoUseMinutes: 10 });
    await vi.waitFor(() => expect(mocks.configure).toHaveBeenCalledWith({ codexResetCreditAutoUseMinutes: 10 }));
  });

  it("rejects invalid thresholds before writing settings", async () => {
    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codexResetCreditAutoUseMinutes: -1 }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
  });
});
