import { describe, expect, it } from "vitest";

import { PROVIDERS } from "../../open-sse/config/providers.js";
import { VOLCEAPI_KIMI_K3_MODEL, VOLCEAPI_REQUEST_OVERRIDES } from "../../open-sse/config/volceapi.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import {
  applyRequestBodyOverrides,
  modelMatchesOverride,
  resolveRequestHeaderOverrides,
} from "../../open-sse/services/requestOverrides.js";

describe("requestOverrides", () => {
  it("matches exact model ids after thinking-suffix strip", () => {
    expect(modelMatchesOverride({ models: ["kimi-k3"] }, "kimi-k3")).toBe(true);
    expect(modelMatchesOverride({ models: ["kimi-k3"] }, "kimi-k3(high)")).toBe(true);
    expect(modelMatchesOverride({ models: ["kimi-k3"] }, "glm-5.3")).toBe(false);
  });

  it("forces set params and drops listed keys", () => {
    const body = { temperature: 0.7, top_p: 0.9, max_tokens: 128 };
    applyRequestBodyOverrides(body, [
      { models: ["kimi-k3"], set: { temperature: 1 }, drop: ["top_p"] },
    ], "kimi-k3");
    expect(body).toEqual({ temperature: 1, max_tokens: 128 });
  });

  it("applies a no-matcher rule to every model of the provider", () => {
    const body = { temperature: 0.2 };
    applyRequestBodyOverrides(body, [{ set: { temperature: 1 } }], "anything");
    expect(body.temperature).toBe(1);
  });

  it("skips reserved override headers", () => {
    expect(resolveRequestHeaderOverrides([
      { headers: { Authorization: "Bearer spoof", "X-Trace": "abc" } },
    ], "kimi-k3")).toEqual({ "X-Trace": "abc" });
  });
});

describe("volceapi kimi-k3 overrides (issue #20)", () => {
  it("registers temperature=1 for kimi-k3 only", () => {
    expect(PROVIDERS.volceapi.requestOverrides).toEqual(VOLCEAPI_REQUEST_OVERRIDES);
    const kimi = { temperature: 0.7, model: VOLCEAPI_KIMI_K3_MODEL };
    const glm = { temperature: 0.7, model: "glm-5.3" };
    const executor = new DefaultExecutor("volceapi");
    expect(executor.transformRequest(VOLCEAPI_KIMI_K3_MODEL, kimi).temperature).toBe(1);
    expect(executor.transformRequest("glm-5.3", glm).temperature).toBe(0.7);
  });

  it("forces temperature=1 even when the client omitted it", () => {
    const executor = new DefaultExecutor("volceapi");
    expect(executor.transformRequest(VOLCEAPI_KIMI_K3_MODEL, { messages: [] }).temperature).toBe(1);
  });

  it("merges override headers without replacing Authorization", () => {
    const executor = new DefaultExecutor("volceapi");
    executor.config = {
      ...PROVIDERS.volceapi,
      requestOverrides: [{ headers: { Authorization: "Bearer spoof", "X-Trace": "abc" } }],
    };
    const headers = executor.buildHeaders({ apiKey: "sk-volce" }, false, undefined, VOLCEAPI_KIMI_K3_MODEL);
    expect(headers.Authorization).toBe("Bearer sk-volce");
    expect(headers["X-Trace"]).toBe("abc");
  });
});
