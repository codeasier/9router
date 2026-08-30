import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

// GetUsableModels goes over node:http2 (agent.api5.cursor.sh is HTTP/2-only; fetch
// cannot speak h2, see 6994cd1f). These tests used to mock global.fetch, which the
// code never calls: the success case could not pass and the 403 case passed because
// a real connection failed. Fake the http2 client instead.
const h2 = vi.hoisted(() => ({ status: 200, body: new Uint8Array(), calls: [] }));
vi.mock("http2", async () => {
  const { EventEmitter } = await import("node:events");
  const connect = (origin) => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      const req = new EventEmitter();
      req.end = (body) => {
        h2.calls.push({ origin, headers, body });
        queueMicrotask(() => {
          req.emit("response", { ":status": h2.status });
          if (h2.body.length) req.emit("data", Buffer.from(h2.body));
          req.emit("end");
        });
      };
      return req;
    };
    return client;
  };
  return { default: { connect }, connect };
});
import { resolveOutboundProxyUrl } from "../../open-sse/utils/proxyFetch.js";
import { buildHttpConnectRequest, isSocksProxyUrl } from "../../open-sse/utils/http2Connect.js";

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.calls.length = 0;
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    h2.status = 200;
    h2.body = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2.calls).toHaveLength(1);
    expect(h2.calls[0].origin).toBe("https://agent.api5.cursor.sh");
    expect(h2.calls[0].headers).toEqual(expect.objectContaining({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      "content-type": "application/proto",
      accept: "application/proto",
    }));
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.status = 403;
    h2.body = new TextEncoder().encode("no");
    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
    expect(h2.calls).toHaveLength(1);
  });

  it("supports an injected HTTP/2 proxy transport and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const http2Post = vi.fn().mockResolvedValue({ status: 200, body: payload });
    const credentials = { accessToken: "cursor-token" };
    await expect(resolveCursorModels(credentials, { http2Post })).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await resolveCursorModels(credentials, { http2Post });
    expect(http2Post).toHaveBeenCalledTimes(1);
    expect(http2Post).toHaveBeenCalledWith(
      "https://agent.api5.cursor.sh/agent.v1.AgentService/GetUsableModels",
      expect.objectContaining({
        "content-type": "application/proto",
        accept: "application/proto",
      }),
      expect.any(Uint8Array),
      undefined,
    );
  });

  it("fails open when the Cursor catalog request fails", async () => {
    const http2Post = vi.fn().mockResolvedValue({ status: 403, body: Buffer.from("no") });

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    }, { http2Post })).resolves.toBeNull();
  });
});

describe("HTTP/2 proxy tunnel helpers", () => {
  const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const saved = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("builds an HTTP CONNECT request for mixed-port proxies", () => {
    expect(buildHttpConnectRequest("agent.api5.cursor.sh", 443, "http://127.0.0.1:10808"))
      .toBe("CONNECT agent.api5.cursor.sh:443 HTTP/1.1\r\nHost: agent.api5.cursor.sh:443\r\n\r\n");
  });

  it("includes Proxy-Authorization for credentialed HTTP proxies", () => {
    expect(buildHttpConnectRequest("agent.api5.cursor.sh", 443, "http://user:p%40ss@127.0.0.1:10808"))
      .toContain("Proxy-Authorization: Basic ");
  });

  it("detects SOCKS proxy URLs", () => {
    expect(isSocksProxyUrl("socks5://127.0.0.1:10808")).toBe(true);
    expect(isSocksProxyUrl("http://127.0.0.1:10808")).toBe(false);
  });

  it("prefers a bound connection proxy over env proxy", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    expect(resolveOutboundProxyUrl("https://agent.api5.cursor.sh/models", {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:10808",
    })).toBe("http://127.0.0.1:10808");
  });

  it("falls back to HTTPS_PROXY when no connection proxy is bound", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:10808";
    expect(resolveOutboundProxyUrl("https://agent.api5.cursor.sh/models", null))
      .toBe("http://127.0.0.1:10808");
  });
});
