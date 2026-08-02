import { describe, expect, it } from "vitest";
import {
  mergeCustomHeaders,
  normalizeCustomHeaders,
  resolveCustomHeaders,
} from "open-sse/utils/customHeaders.js";

describe("custom request headers", () => {
  it("resolves environment references without mutating templates", () => {
    const templates = { "User-Agent": "${CLIENT_NAME}", "X-Trace": "prefix-${TRACE_ID}" };
    expect(resolveCustomHeaders(templates, { CLIENT_NAME: "undici", TRACE_ID: "abc" })).toEqual({
      "User-Agent": "undici",
      "X-Trace": "prefix-abc",
    });
    expect(templates["User-Agent"]).toBe("${CLIENT_NAME}");
  });

  it("keeps arbitrary headers while protecting router-owned headers", () => {
    expect(mergeCustomHeaders(
      { Authorization: "Bearer key", "Content-Type": "application/json" },
      { "User-Agent": "undici", authorization: "spoofed", Host: "bad" },
    )).toEqual({
      Authorization: "Bearer key",
      "Content-Type": "application/json",
      "User-Agent": "undici",
    });
  });

  it("rejects invalid names, non-string values, and line breaks", () => {
    expect(() => normalizeCustomHeaders({ "Bad Header": "value" })).toThrow("Invalid custom header name");
    expect(() => normalizeCustomHeaders({ "X-Test": 123 })).toThrow("Invalid custom header value");
    expect(() => normalizeCustomHeaders({ "X-Test": "ok\nsecret" })).toThrow("Invalid custom header value");
  });
});
