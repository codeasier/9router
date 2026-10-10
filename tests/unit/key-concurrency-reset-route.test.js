import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => {
  const previousJwtSecret = process.env.JWT_SECRET;
  const jwtSecret = "key-concurrency-route-test-secret-only";
  process.env.JWT_SECRET = jwtSecret;
  return {
    previousJwtSecret,
    jwtSecret,
    nextResponse: Symbol("next"),
    getSettings: vi.fn(),
    validateApiKey: vi.fn(),
    getApiKeyById: vi.fn(),
    getApiKeyByKey: vi.fn(),
    updateApiKey: vi.fn(),
    getConsistentMachineId: vi.fn(),
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => Response.json(body, init),
    next: () => mocks.nextResponse,
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
  getApiKeyById: mocks.getApiKeyById,
  getApiKeyByKey: mocks.getApiKeyByKey,
  updateApiKey: mocks.updateApiKey,
  deleteApiKey: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => ({ getApiKeyById: mocks.getApiKeyById }));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

const KEY = "sk-route-key-secret";
const OTHER_KEY = "sk-other-route-key-secret";
const KEY_ID = "key-record-id";
const CLI_TOKEN = "existing-management-cli-token";
const PATH = `/api/keys/${KEY_ID}/reset-concurrency`;
const context = { params: Promise.resolve({ id: KEY_ID }) };
let keyPolicy;
let route;
let guard;
let session;
let keyRecord;

function request({ headers = {}, token, path = PATH, body } = {}) {
  return {
    headers: new Headers(headers),
    cookies: { get: (name) => name === "auth_token" && token ? { value: token } : undefined },
    nextUrl: { pathname: path, searchParams: new URL(`http://localhost${path}`).searchParams },
    url: `http://localhost${path}`,
    json: async () => body,
  };
}

async function inflight(key = KEY) {
  return (await keyPolicy.getKeyPolicyStatus(key)).inflight;
}

function acquire(key = KEY) {
  const slot = keyPolicy.acquireSlot(key, { maxConcurrent: 2 });
  expect(slot.ok).toBe(true);
  return slot;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  keyRecord = { id: KEY_ID, key: KEY, policy: { maxConcurrent: 2 } };
  mocks.getSettings.mockResolvedValue({ requireLogin: false });
  // Even a valid ordinary API key must not authorize the management route.
  mocks.validateApiKey.mockResolvedValue(true);
  mocks.getConsistentMachineId.mockResolvedValue(CLI_TOKEN);
  mocks.getApiKeyById.mockImplementation(async (id) => id === KEY_ID ? keyRecord : null);
  mocks.getApiKeyByKey.mockImplementation(async (key) => (
    key === KEY ? keyRecord : { key, policy: { maxConcurrent: 2 } }
  ));
  mocks.updateApiKey.mockImplementation(async (id, update) => ({ ...keyRecord, ...update }));
  keyPolicy = await import("@/sse/services/keyPolicy.js");
  keyPolicy._resetKeyPolicyState();
  keyPolicy._setBudgetQuery(async () => 0);
  route = await import("@/app/api/keys/[id]/reset-concurrency/route.js");
  guard = await import("@/dashboardGuard");
  session = await import("@/lib/auth/dashboardSession");
});

afterEach(() => {
  keyPolicy?._resetKeyPolicyState();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (mocks.previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = mocks.previousJwtSecret;
});

describe("explicit process-local key concurrency reset authentication", () => {
  it.each([true, false])("rejects anonymous requests when requireLogin=%s", async (requireLogin) => {
    mocks.getSettings.mockResolvedValue({ requireLogin });
    acquire();
    const response = await route.POST(request(), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.getApiKeyById).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(await inflight()).toBe(1);
  });

  it("enforces credentials in the route even after no-login middleware allows access", async () => {
    const req = request({ headers: { host: "localhost:20128" } });
    expect(await guard.proxy(req)).toBe(mocks.nextResponse);
    expect(await guard.isAuthenticated(req)).toBe(true);
    const response = await route.POST(req, context);
    expect(response.status).toBe(401);
    expect(mocks.getApiKeyById).not.toHaveBeenCalled();
  });

  it.each([
    { authorization: `Bearer ${KEY}` },
    { "x-api-key": KEY },
    { "x-goog-api-key": KEY },
    { "x-9r-cli-token": KEY },
  ])("rejects ordinary API keys presented as %j", async (headers) => {
    acquire();
    const response = await route.POST(request({ headers }), context);
    expect(response.status).toBe(401);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
    expect(mocks.getApiKeyById).not.toHaveBeenCalled();
    expect(await inflight()).toBe(1);
  });

  it("rejects an ordinary API key in the cookie or query string", async () => {
    for (const req of [request({ token: KEY }), request({ path: `${PATH}?key=${KEY}` })]) {
      expect((await route.POST(req, context)).status).toBe(401);
    }
    expect(mocks.getApiKeyById).not.toHaveBeenCalled();
  });

  it("rejects forged, expired, and malformed JWT cookies", async () => {
    acquire();
    const expired = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(mocks.jwtSecret));
    const forged = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("untrusted-signing-secret"));
    for (const token of [expired, forged, "not-a-jwt"]) {
      expect((await route.POST(request({ token }), context)).status).toBe(401);
    }
    expect(mocks.getApiKeyById).not.toHaveBeenCalled();
    expect(await inflight()).toBe(1);
  });

  it("rejects invalid CLI tokens rather than trusting header presence", async () => {
    const response = await route.POST(request({ headers: { "x-9r-cli-token": "wrong-token" } }), context);
    expect(response.status).toBe(401);
    expect(mocks.getConsistentMachineId).toHaveBeenCalledWith("9r-cli-auth");
    expect(mocks.getApiKeyById).not.toHaveBeenCalled();
  });
});

describe("explicit key concurrency reset behavior", () => {
  it("accepts a real dashboard JWT and returns the exact cleared count without secrets", async () => {
    acquire();
    acquire();
    acquire(OTHER_KEY);
    const token = await session.createDashboardAuthToken();
    const response = await route.POST(request({ token }), context);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ ok: true, clearedSlots: 2, scope: "process", requestsCancelled: false });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(mocks.getApiKeyById).toHaveBeenCalledWith(KEY_ID);
    expect(await inflight()).toBe(0);
    expect(await inflight(OTHER_KEY)).toBe(1);
  });

  it("accepts the existing verified CLI token and succeeds with zero slots", async () => {
    const response = await route.POST(request({ headers: { "x-9r-cli-token": CLI_TOKEN } }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, clearedSlots: 0, scope: "process", requestsCancelled: false });
    expect(mocks.getConsistentMachineId).toHaveBeenCalledWith("9r-cli-auth");
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown key only after management authentication", async () => {
    acquire();
    const response = await route.POST(request({ headers: { "x-9r-cli-token": CLI_TOKEN } }), {
      params: Promise.resolve({ id: "unknown-id" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Key not found" });
    expect(await inflight()).toBe(1);
  });

  it("does not abort an old response or let it release a newly acquired slot", async () => {
    const oldSlot = acquire();
    const cancel = vi.fn();
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; }, cancel });
    const oldResponse = keyPolicy.wrapResponseForSlot(new Response(body), oldSlot);
    await route.POST(request({ headers: { "x-9r-cli-token": CLI_TOKEN } }), context);
    const newSlot = acquire();
    controller.enqueue(new TextEncoder().encode("old request still completes"));
    controller.close();
    expect(await oldResponse.text()).toBe("old request still completes");
    expect(cancel).not.toHaveBeenCalled();
    oldSlot.release();
    expect(await inflight()).toBe(1);
    newSlot.release();
    expect(await inflight()).toBe(0);
  });

  it("does not reset an open budget breaker", async () => {
    acquire();
    keyPolicy._setBudgetQuery(async () => 2);
    const policy = { budgets: [{ provider: "*", limitUsd: 1, period: "day" }] };
    expect((await keyPolicy.checkBudget(KEY, policy, "codex")).ok).toBe(false);
    await route.POST(request({ headers: { "x-9r-cli-token": CLI_TOKEN } }), context);
    expect((await keyPolicy.checkBudget(KEY, policy, "codex")).ok).toBe(false);
    expect(await inflight()).toBe(0);
  });

  it("returns a generic error without logging credentials on storage failure", async () => {
    mocks.getApiKeyById.mockRejectedValueOnce(new Error(`database error contains ${KEY}`));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(request({ headers: { "x-9r-cli-token": CLI_TOKEN } }), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to reset key concurrency" });
    expect(errorLog).toHaveBeenCalledWith("Error resetting key concurrency");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(KEY);
  });
});

describe("ordinary policy operations never clear concurrency", () => {
  it("single-key breaker/cache reset keeps occupied slots and rejects new acquisition", async () => {
    acquire();
    acquire();
    const { POST } = await import("@/app/api/keys/[id]/reset/route.js");
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).status.inflight).toBe(2);
    expect(keyPolicy.acquireSlot(KEY, { maxConcurrent: 2 }).ok).toBe(false);
  });

  it("bulk breaker/cache reset keeps occupied slots", async () => {
    acquire();
    const { POST } = await import("@/app/api/keys/bulk/reset/route.js");
    const response = await POST(request({ body: { ids: [KEY_ID] } }));
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].status.inflight).toBe(1);
    expect(await inflight()).toBe(1);
  });

  it("saving a changed policy keeps occupied slots", async () => {
    acquire();
    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const response = await PUT(request({ body: { policy: { maxConcurrent: 3 } } }), context);
    expect(response.status).toBe(200);
    expect(await inflight()).toBe(1);
  });
});
