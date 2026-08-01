import { describe, expect, it } from "vitest";
import blackForestLabs from "../../open-sse/providers/registry/black-forest-labs.js";
import stepPlan from "../../open-sse/providers/registry/step-plan.js";
import {
  buildParamRequest,
  getParamDefaults,
  IMAGE_EXAMPLE_FIELDS,
  isFixedNumberField,
  resolveParamFields,
} from "../../src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/exampleParams.js";

const STEP_MODEL = stepPlan.models.find((model) => model.id === "step-image-edit-2");

describe("dashboard image example parameters", () => {
  it("resolves fields in params order and replaces global options with model options", () => {
    const fields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, STEP_MODEL);

    expect(fields.map((field) => field.key)).toEqual(STEP_MODEL.params);
    expect(fields.find((field) => field.key === "size").options).toEqual(STEP_MODEL.paramConfig.size.options);
    expect(fields.find((field) => field.key === "size").options).not.toContain("auto");
    expect(fields.find((field) => field.key === "response_format").options).toEqual(["url", "b64_json"]);
  });

  it("renders only complete supported merged or standalone definitions", () => {
    const fields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, {
      params: ["n", "standalone", "missing", "unsupported", "bad_select"],
      paramConfig: {
        n: { max: 1 },
        standalone: { label: "Standalone", type: "text", default: "" },
        unsupported: { label: "Unsupported", type: "range" },
        bad_select: { label: "Bad select", type: "select" },
      },
    });

    expect(fields).toEqual([
      { key: "n", label: "n", type: "number", default: 1, min: 1, max: 1 },
      { key: "standalone", label: "Standalone", type: "text", default: "" },
    ]);
  });

  it("builds the exact Step Plan default request parameters", () => {
    const fields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, STEP_MODEL);
    const result = buildParamRequest(fields, getParamDefaults(fields));
    const request = { model: `${stepPlan.id}/${STEP_MODEL.id}`, prompt: "A lighthouse", ...result.params };

    expect(request).toEqual({
      model: "step-plan/step-image-edit-2",
      prompt: "A lighthouse",
      n: 1,
      size: "1024x1024",
      response_format: "url",
      steps: 8,
      cfg_scale: 1,
      text_mode: false,
    });
    expect(result.error).toBe("");
    expect(Object.keys(result.params)).toEqual(["n", "size", "response_format", "steps", "cfg_scale", "text_mode"]);
  });

  it("includes every advanced field, including false and zero values", () => {
    const fields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, STEP_MODEL);
    const values = {
      ...getParamDefaults(fields),
      size: "1184x896",
      response_format: "b64_json",
      seed: 0,
      steps: 50,
      cfg_scale: "4.7",
      negative_prompt: "blurry",
      text_mode: false,
      quality: "high",
    };

    expect(buildParamRequest(fields, values)).toEqual({
      params: {
        n: 1,
        size: "1184x896",
        response_format: "b64_json",
        seed: 0,
        steps: 50,
        cfg_scale: 4.7,
        negative_prompt: "blurry",
        text_mode: false,
      },
      error: "",
    });
  });

  it("forces fixed numbers and validates number ranges and decimal steps locally", () => {
    const fields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, STEP_MODEL);
    const defaults = getParamDefaults(fields);
    const countField = fields.find((field) => field.key === "n");

    expect(isFixedNumberField(countField)).toBe(true);
    expect(buildParamRequest(fields, { ...defaults, n: 99 }).params.n).toBe(1);
    expect(buildParamRequest(fields, { ...defaults, steps: 0 }).error).toContain("Steps");
    expect(buildParamRequest(fields, { ...defaults, steps: 1.5 }).error).toContain("Steps");
    expect(buildParamRequest(fields, { ...defaults, cfg_scale: 10.1 }).error).toContain("CFG scale");
    expect(buildParamRequest(fields, { ...defaults, cfg_scale: 1.05 }).error).toContain("CFG scale");
    expect(buildParamRequest(fields, { ...defaults, cfg_scale: 1.1 }).error).toBe("");
  });

  it("uses boolean defaults and resets model values from the newly resolved fields", () => {
    const stepFields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, STEP_MODEL);
    const otherFields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, { params: ["size"] });

    expect(stepFields.find((field) => field.key === "text_mode").type).toBe("boolean");
    expect(getParamDefaults(stepFields).text_mode).toBe(false);
    expect(getParamDefaults(otherFields)).toEqual({ size: "auto" });
  });

  it("keeps declared Flux fields and omits undeclared global defaults", () => {
    const fluxModel = blackForestLabs.models.find((model) => model.id === "flux-pro-1.1");
    const fields = resolveParamFields(IMAGE_EXAMPLE_FIELDS, fluxModel);
    const result = buildParamRequest(fields, getParamDefaults(fields));

    expect(fields.map((field) => field.key)).toEqual(["n", "size"]);
    expect(result).toEqual({ params: { n: 1, size: "auto" }, error: "" });
    expect(result.params).not.toHaveProperty("quality");
    expect(result.params).not.toHaveProperty("background");
    expect(result.params).not.toHaveProperty("image_detail");
    expect(result.params).not.toHaveProperty("output_format");
  });
});
