import { describe, expect, it } from "vitest";

import { getImageAdapter, isImageProvider } from "../../open-sse/handlers/imageProviders/index.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { parseModel } from "../../open-sse/services/model.js";
import {
  AI_PROVIDERS,
  APIKEY_PROVIDERS,
  getProvidersByKind,
} from "../../src/shared/constants/providers.js";

describe("Step Plan provider registry and discovery", () => {
  const entries = REGISTRY.filter((entry) => entry.id === "step-plan");
  const stepPlan = entries[0];

  it("has exactly the specified image-only API-key identity and display metadata", () => {
    expect(entries).toHaveLength(1);
    expect(Object.keys(stepPlan)).toEqual([
      "id",
      "priority",
      "alias",
      "display",
      "category",
      "authType",
      "authModes",
      "models",
      "serviceKinds",
      "imageConfig",
    ]);
    expect(stepPlan).toMatchObject({
      id: "step-plan",
      alias: "step-plan",
      priority: 80,
      category: "apikey",
      authType: "apikey",
      authModes: ["apikey"],
      serviceKinds: ["image"],
      display: {
        name: "StepFun Step Plan",
        icon: "image",
        color: "#FF6A00",
        textIcon: "SP",
        website: "https://platform.stepfun.com",
        notice: { apiKeyUrl: "https://platform.stepfun.com/interface-key" },
      },
    });
    expect(stepPlan).not.toHaveProperty("transport");
  });

  it("publishes exact generation and safe validation configuration", () => {
    expect(stepPlan.imageConfig).toEqual({
      baseUrl: "https://api.stepfun.com/step_plan/v1/images/generations",
      authType: "apikey",
      authHeader: "bearer",
      validateUrl: "https://api.stepfun.com/step_plan/v1/models",
      validateMethod: "GET",
    });
    expect(PROVIDER_MEDIA["step-plan"]).toEqual({
      serviceKinds: ["image"],
      imageConfig: stepPlan.imageConfig,
    });
  });

  it("publishes only the exact Step Plan image model metadata without edit capability", () => {
    expect(stepPlan.models).toEqual([
      {
        id: "step-image-edit-2",
        name: "Step Image Edit 2",
        kind: "image",
        params: ["n", "size", "response_format", "seed", "steps", "cfg_scale", "negative_prompt", "text_mode"],
        paramConfig: {
          n: { label: "n", type: "number", default: 1, min: 1, max: 1, step: 1 },
          size: {
            label: "Size",
            type: "select",
            default: "1024x1024",
            options: ["1024x1024", "768x1360", "896x1184", "1360x768", "1184x896"],
          },
          response_format: { label: "Format", type: "select", default: "url", options: ["url", "b64_json"] },
          seed: { label: "Seed", type: "number", default: "", min: 0, max: 2147483647, step: 1 },
          steps: { label: "Steps", type: "number", default: 8, min: 1, max: 50, step: 1 },
          cfg_scale: { label: "CFG scale", type: "number", default: 1, min: 1, max: 10, step: 0.1 },
          negative_prompt: { label: "Negative prompt", type: "text", default: "" },
          text_mode: { label: "Text mode", type: "boolean", default: false },
        },
      },
    ]);
    expect(stepPlan.models[0]).not.toHaveProperty("capabilities");
    expect(PROVIDER_MODELS["step-plan"]).toEqual(stepPlan.models);
  });

  it("is discoverable for image UI and generic API-key connection creation", () => {
    expect(APIKEY_PROVIDERS["step-plan"]).toBeDefined();
    expect(AI_PROVIDERS["step-plan"].authType).toBe("apikey");
    expect(AI_PROVIDERS["step-plan"].authModes).toEqual(["apikey"]);
    expect(getProvidersByKind("image").map((provider) => provider.id)).toContain("step-plan");
    expect(getProvidersByKind("llm").map((provider) => provider.id)).not.toContain("step-plan");
  });

  it("resolves the provider/model identity without normalization changes", () => {
    expect(parseModel("step-plan/step-image-edit-2")).toEqual({
      provider: "step-plan",
      model: "step-image-edit-2",
      isAlias: false,
      providerAlias: "step-plan",
    });
  });

  it("has an image adapter for every published Step Plan image model", () => {
    expect(isImageProvider("step-plan")).toBe(true);
    expect(getImageAdapter("step-plan")).toBeDefined();
    for (const model of PROVIDER_MODELS["step-plan"].filter((entry) => entry.kind === "image")) {
      expect(getImageAdapter("step-plan"), model.id).toBeDefined();
    }
  });

  it("normalizes successful upstream bodies by identity", () => {
    const adapter = getImageAdapter("step-plan");
    const upstreamBody = {
      id: "step-id",
      created: 1,
      data: [{ url: "https://example.com/image.png", finish_reason: "success", seed: 0 }],
    };

    expect(adapter.normalize(upstreamBody)).toBe(upstreamBody);
  });

  it("keeps all registry IDs unique", () => {
    const ids = REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
