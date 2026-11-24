// GET /api/providers/[connectionId]/models → Trae account directory → UI rows.
// Self-isolating: DATA_DIR points at a temp dir so seeding never touches ~/.9router.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const stub = vi.hoisted(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return { mode: "ok", calls: [], nativeFetch };
});

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options) => {
    const href = String(url);
    const body = options?.body ? JSON.parse(options.body) : null;
    stub.calls.push({ url: href, function: body?.function || "" });
    if (!href.includes("/api/ide/v1/get_detail_param")) return stub.nativeFetch(url, options);
    if (stub.mode === "error") return new Response("boom", { status: 500 });
    if (stub.mode === "empty") return Response.json({ config_info_list: [] });
    return Response.json({
      config_info_list: [
        { config_name: "live-model", display_config: { display_name: "Live Model" }, usage: "chat_completion" },
        { config_name: "local-only", use_remote_service: false, usage: "chat_completion" },
      ],
    });
  },
  default: async (url, options) => stub.nativeFetch(url, options),
}));

const originalDataDir = process.env.DATA_DIR;
let GET;
let createProviderConnection;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-trae-live-"));
  vi.resetModules();
  ({ GET } = await import("@/app/api/providers/[id]/models/route.js"));
  ({ createProviderConnection } = await import("@/models/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // The sqlite handle can keep the temp dir locked. The OS cleans it up.
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  stub.mode = "ok";
  stub.calls.length = 0;
});

async function seed(provider, token) {
  return createProviderConnection({
    provider,
    authType: "oauth",
    accessToken: token,
    testStatus: "active",
  });
}

async function getModels(connectionId) {
  const req = new Request(`http://localhost/api/providers/${connectionId}/models`);
  return GET(req, { params: Promise.resolve({ id: connectionId }) });
}

describe("Trae live model directory", () => {
  it("replaces the handwritten rows with the account directory", async () => {
    const conn = await seed("trae", "jwt-cn-secret");
    const res = await getModels(conn.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models.map((model) => model.id)).toEqual(["live-model"]);
    expect(data.models[0].name).toBe("Live Model");
    expect(data.warning).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("jwt-cn-secret");
    expect(stub.calls.map((call) => call.function)).toEqual([
      "solo_work_remote",
      "solo_work_lite",
      "solo_agent_remote",
      "chat_v3",
      "solo_coder",
    ]);
    expect(stub.calls[0].url).toContain("https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param");
  });

  it("asks the international gateway without the CN coder channel", async () => {
    const conn = await seed("trae-global", "jwt-sg");
    const data = await (await getModels(conn.id)).json();
    expect(data.models.map((model) => model.id)).toEqual(["live-model"]);
    expect(stub.calls.map((call) => call.function)).not.toContain("solo_coder");
    expect(stub.calls[0].url).toContain("https://coresg-normal.trae.ai/api/ide/v1/get_detail_param");
  });

  it("keeps the handwritten rows when the directory is empty", async () => {
    stub.mode = "empty";
    const conn = await seed("trae-enterprise", "jwt-ent");
    const data = await (await getModels(conn.id)).json();
    expect(data.models.map((model) => model.id)).toContain("glm-5.2");
    expect(data.models.map((model) => model.id)).not.toContain("gemini-3.1-pro");
    expect(data.warning).toMatch(/static catalog/i);
    expect(stub.calls[0].url).toContain("https://console.enterprise.trae.cn/api/ide/v1/get_detail_param");
  });
});
