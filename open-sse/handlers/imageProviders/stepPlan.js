import { PROVIDER_MEDIA } from "../../providers/index.js";

const PROVIDER_ID = "step-plan";
const VALID_SIZES = new Set(["1024x1024", "768x1360", "896x1184", "1360x768", "1184x896"]);
const VALID_RESPONSE_FORMATS = new Set(["url", "b64_json"]);

function assertString(value, field, maxLength) {
  if (typeof value !== "string" || (field === "prompt" && value.length === 0)) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
}

function assertInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
}

function assertNumber(value, field, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number from ${min} to ${max}`);
  }
}

export default {
  buildUrl: () => PROVIDER_MEDIA[PROVIDER_ID].imageConfig.baseUrl,
  buildEditUrl: () => PROVIDER_MEDIA[PROVIDER_ID].imageConfig.baseUrl.replace(/\/images\/generations$/, "/images/edits"),
  buildHeaders: (credentials) => {
    const key = credentials?.apiKey || credentials?.accessToken;
    return {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  },
  buildEditBody: (model, body) => {
    assertString(body.prompt, "prompt", 512);

    const images = body.images || (body.image ? [body.image] : []);
    if (images.length !== 1) {
      throw new Error("Step Plan supports exactly one input image for edits");
    }
    const img = images[0];
    if (!img?.b64) throw new Error("image must contain base64 data");

    const fd = new FormData();
    fd.append("model", model);
    fd.append("image", new Blob([Buffer.from(img.b64, "base64")], { type: img.mime || "image/png" }), img.name || "image.png");
    fd.append("prompt", body.prompt);

    if (body.seed !== undefined) {
      assertInteger(body.seed, "seed", 0, 2147483647);
      fd.append("seed", String(body.seed));
    }
    if (body.steps !== undefined) {
      assertInteger(body.steps, "steps", 1, 50);
      fd.append("steps", String(body.steps));
    }
    const cfgScale = body.cfg_scale ?? body.cfg;
    if (cfgScale !== undefined) {
      assertNumber(cfgScale, "cfg_scale", 1, 10);
      fd.append("cfg_scale", String(cfgScale));
    }
    if (body.negative_prompt !== undefined) {
      if (typeof body.negative_prompt !== "string") throw new Error("negative_prompt must be a string");
      if (Array.from(body.negative_prompt).length > 512) throw new Error("negative_prompt must be at most 512 characters");
      fd.append("negative_prompt", body.negative_prompt);
    }
    if (body.text_mode !== undefined) {
      if (typeof body.text_mode !== "boolean") throw new Error("text_mode must be a boolean");
      fd.append("text_mode", String(body.text_mode));
    }
    if (body.response_format !== undefined) {
      if (typeof body.response_format !== "string" || !VALID_RESPONSE_FORMATS.has(body.response_format)) {
        throw new Error("response_format must be url or b64_json");
      }
      fd.append("response_format", body.response_format);
    }

    return fd;
  },
  buildBody: (model, body) => {
    assertString(body.prompt, "prompt", 512);

    const request = { model, prompt: body.prompt, n: body.n === undefined ? 1 : body.n };
    assertInteger(request.n, "n", 1, 1);

    if (body.size !== undefined && body.size !== "auto") {
      if (typeof body.size !== "string" || !VALID_SIZES.has(body.size)) {
        throw new Error("size is not supported by Step Plan");
      }
      request.size = body.size;
    }
    if (body.response_format !== undefined) {
      if (typeof body.response_format !== "string" || !VALID_RESPONSE_FORMATS.has(body.response_format)) {
        throw new Error("response_format must be url or b64_json");
      }
      request.response_format = body.response_format;
    }
    if (body.seed !== undefined) {
      assertInteger(body.seed, "seed", 0, 2147483647);
      request.seed = body.seed;
    }
    if (body.steps !== undefined) {
      assertInteger(body.steps, "steps", 1, 50);
      request.steps = body.steps;
    }
    const cfgScale = body.cfg_scale ?? body.cfg;
    if (cfgScale !== undefined) {
      assertNumber(cfgScale, "cfg_scale", 1, 10);
      request.cfg_scale = cfgScale;
    }
    if (body.negative_prompt !== undefined) {
      if (typeof body.negative_prompt !== "string") {
        throw new Error("negative_prompt must be a string");
      }
      if (Array.from(body.negative_prompt).length > 512) {
        throw new Error("negative_prompt must be at most 512 characters");
      }
      request.negative_prompt = body.negative_prompt;
    }
    if (body.text_mode !== undefined) {
      if (typeof body.text_mode !== "boolean") {
        throw new Error("text_mode must be a boolean");
      }
      request.text_mode = body.text_mode;
    }

    return request;
  },
  normalize: (responseBody) => responseBody,
};
