export default {
  id: "step-plan",
  priority: 80,
  alias: "step-plan",
  display: {
    name: "StepFun Step Plan",
    icon: "image",
    color: "#FF6A00",
    textIcon: "SP",
    website: "https://platform.stepfun.com",
    notice: {
      apiKeyUrl: "https://platform.stepfun.com/interface-key",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  models: [
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
        cfg_scale: { label: "CFG scale", type: "number", default: 1.0, min: 1.0, max: 10.0, step: 0.1 },
        negative_prompt: { label: "Negative prompt", type: "text", default: "" },
        text_mode: { label: "Text mode", type: "boolean", default: false },
      },
    },
  ],
  serviceKinds: ["image"],
  imageConfig: {
    baseUrl: "https://api.stepfun.com/step_plan/v1/images/generations",
    authType: "apikey",
    authHeader: "bearer",
    validateUrl: "https://api.stepfun.com/step_plan/v1/models",
    validateMethod: "GET",
  },
};
