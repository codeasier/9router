import { describe, expect, it } from "vitest";

import {
  assertHttp2ProxyPolicy,
  getHttpProxySocketConfig,
  isSocksProxyUrl,
} from "../../open-sse/utils/http2Connect.js";

describe("HTTP/2 proxy connection policy", () => {
  it("uses TLS for HTTPS proxies while preserving plain HTTP proxies", () => {
    expect(getHttpProxySocketConfig("https://proxy.example")).toEqual({
      secure: true,
      connectEvent: "secureConnect",
      options: { host: "proxy.example", port: 443, servername: "proxy.example" },
    });
    expect(getHttpProxySocketConfig("http://proxy.example:8080")).toEqual({
      secure: false,
      connectEvent: "connect",
      options: { host: "proxy.example", port: 8080 },
    });
  });

  it("keeps SOCKS URLs on the SOCKS tunnel path", () => {
    expect(isSocksProxyUrl("socks5://127.0.0.1:10808")).toBe(true);
    expect(isSocksProxyUrl("https://proxy.example")).toBe(false);
  });

  it("rejects strict application relays instead of allowing direct h2", () => {
    expect(() => assertHttp2ProxyPolicy({
      vercelRelayUrl: "https://relay.example/api/proxy",
      strictProxy: true,
    })).toThrow(/application-layer relay.*strictProxy=true/);
    expect(() => assertHttp2ProxyPolicy({
      vercelRelayUrl: "https://relay.example/api/proxy",
      strictProxy: false,
    })).not.toThrow();
  });
});
