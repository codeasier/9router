import { describe, expect, it } from "vitest";
import {
  mergeCustomHeaders,
  mergeNormalizedCustomHeaders,
  normalizeCustomHeaders,
  resolveCustomHeaders,
} from "open-sse/utils/customHeaders.js";
import { maskSensitiveHeaders } from "open-sse/utils/requestLogger.js";
import { DefaultExecutor } from "open-sse/executors/default.js";
import openAICompatibleEmbedding from "open-sse/handlers/embeddingProviders/openaiCompatNode.js";

describe("custom request headers", () => {
  it("resolves environment references without mutating templates", () => {
    const templates = { "User-Agent": "${CLIENT_NAME}", "X-Trace": "prefix-${TRACE_ID}" };
    expect(resolveCustomHeaders(templates, {
      CUSTOM_HEADER_ENV_ALLOWLIST: "CLIENT_NAME, TRACE_ID",
      CLIENT_NAME: "undici",
      TRACE_ID: "abc",
    })).toEqual({
      "User-Agent": "undici",
      "X-Trace": "prefix-abc",
    });
    expect(templates["User-Agent"]).toBe("${CLIENT_NAME}");
  });

  it("rejects environment references outside the explicit allowlist", () => {
    expect(() => resolveCustomHeaders(
      { "X-Secret": "${JWT_SECRET}" },
      { JWT_SECRET: "must-not-leak" },
    )).toThrow("Custom header environment variable is not allowlisted");
  });

  it("rejects allowlisted variables that are not set", () => {
    expect(() => resolveCustomHeaders(
      { "X-Token": "${CUSTOM_TOKEN}" },
      { CUSTOM_HEADER_ENV_ALLOWLIST: "CUSTOM_TOKEN" },
    )).toThrow("Custom header environment variable is not set");
  });

  it("rejects line breaks introduced by environment expansion", () => {
    expect(() => resolveCustomHeaders(
      { "X-Token": "${CUSTOM_TOKEN}" },
      {
        CUSTOM_HEADER_ENV_ALLOWLIST: "CUSTOM_TOKEN",
        CUSTOM_TOKEN: "safe\r\nX-Injected: value",
      },
    )).toThrow("Custom header environment variable contains invalid characters");
  });

  it("can merge validated inline headers without environment expansion", () => {
    expect(mergeNormalizedCustomHeaders(
      { Authorization: "Bearer key" },
      normalizeCustomHeaders({ "X-Literal": "${JWT_SECRET}" }),
    )).toEqual({
      Authorization: "Bearer key",
      "X-Literal": "${JWT_SECRET}",
    });
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

  it("redacts arbitrary request headers from request logs", () => {
    expect(maskSensitiveHeaders({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
      "User-Agent": "environment-derived-secret",
      "X-Custom": "custom-secret",
    })).toEqual({
      "Content-Type": "application/json",
      Authorization: "[REDACTED]",
      "User-Agent": "[REDACTED]",
      "X-Custom": "[REDACTED]",
    });
  });

  it("applies custom headers to compatible chat inference", () => {
    const executor = new DefaultExecutor("openai-compatible-test");
    const headers = executor.buildHeaders({
      apiKey: "test-key",
      providerSpecificData: {
        baseUrl: "https://compatible.example/v1",
        headers: { "User-Agent": "undici", "X-Tenant": "tenant-a" },
      },
    });

    expect(headers).toMatchObject({
      Authorization: "Bearer test-key",
      "User-Agent": "undici",
      "X-Tenant": "tenant-a",
    });
  });

  it("applies custom headers to compatible embedding inference", () => {
    const headers = openAICompatibleEmbedding.buildHeaders({
      apiKey: "test-key",
      providerSpecificData: {
        headers: { "User-Agent": "undici", "X-Tenant": "tenant-a" },
      },
    });

    expect(headers).toMatchObject({
      Authorization: "Bearer test-key",
      "User-Agent": "undici",
      "X-Tenant": "tenant-a",
    });
  });
});
