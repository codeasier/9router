import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => Response.json(body, init),
  },
}));

vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => true }));

const { POST } = await import("@/app/api/provider-nodes/validate/route.js");

function requestFor(headers) {
  return {
    json: async () => ({
      baseUrl: "https://compatible.example/v1",
      apiKey: "test-key",
      type: "openai-compatible",
      headers,
    }),
  };
}

describe("provider node validation route custom headers", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    process.env.JWT_SECRET = "must-not-leak";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JWT_SECRET;
  });

  it("rejects inline environment templates instead of reading process.env", async () => {
    const response = await POST(requestFor({
      "User-Agent": "undici",
      "X-Literal": "${JWT_SECRET}",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      valid: false,
      error: "Environment-variable headers can only be checked after saving the provider",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed inline headers before making an outbound request", async () => {
    const response = await POST(requestFor({ "Bad Header": "value" }));

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
