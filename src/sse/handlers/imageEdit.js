import { extractApiKey, isValidApiKey } from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getComboModels } from "../services/model.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS, IMAGE_EDIT_LIMITS } from "open-sse/config/runtimeConfig.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { handleSingleModelImage } from "./imageGeneration.js";
import * as log from "../utils/logger.js";

function fieldString(value) {
  return typeof value === "string" ? value : null;
}

function optionalInt(value) {
  if (typeof value !== "string" || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function fileToImage(file, limits) {
  if (!(file instanceof File)) return null;
  if (!limits.allowedMimeTypes.has(file.type)) {
    throw new Error(`Unsupported image type: ${file.type}`);
  }
  if (file.size > limits.maxFileBytes) {
    throw new Error(`Image too large (max ${Math.round(limits.maxFileBytes / 1024 / 1024)}MB per file)`);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  return {
    b64: buf.toString("base64"),
    mime: file.type || "image/png",
    bytes: file.size,
    name: file.name || "image.png",
  };
}

/**
 * Handle OpenAI-compatible image edit request (POST /v1/images/edits).
 * Accepts multipart/form-data fields: model, image (file, may repeat), prompt,
 * mask (file), n, size, response_format.
 * @param {Request} request
 */
export async function handleImageEdit(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  const modelStr = fieldString(form.get("model"));
  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");

  const prompt = fieldString(form.get("prompt"));
  if (!prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  if (Array.from(prompt).length > IMAGE_EDIT_LIMITS.maxPromptChars) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Prompt too long (max ${IMAGE_EDIT_LIMITS.maxPromptChars} characters)`);
  }

  const files = form.getAll("image").filter((v) => v instanceof File);
  if (files.length === 0) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image");
  }
  if (files.length > IMAGE_EDIT_LIMITS.maxImages) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `At most ${IMAGE_EDIT_LIMITS.maxImages} images allowed`);
  }

  let images;
  let totalBytes = 0;
  try {
    images = [];
    for (const file of files) {
      const img = await fileToImage(file, IMAGE_EDIT_LIMITS);
      if (!img) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid image field");
      totalBytes += img.bytes;
      if (totalBytes > IMAGE_EDIT_LIMITS.maxTotalBytes) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `Total image size too large (max ${Math.round(IMAGE_EDIT_LIMITS.maxTotalBytes / 1024 / 1024)}MB)`);
      }
      images.push(img);
    }
  } catch (error) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, error.message || "Invalid image upload");
  }

  let mask = null;
  const maskFile = form.get("mask");
  if (maskFile instanceof File) {
    try {
      mask = await fileToImage(maskFile, IMAGE_EDIT_LIMITS);
    } catch (error) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, error.message || "Invalid mask upload");
    }
  }

  const body = {
    model: modelStr,
    prompt,
    images,
    mask,
    n: optionalInt(form.get("n")),
    size: fieldString(form.get("size")),
    response_format: fieldString(form.get("response_format")),
  };

  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, operation: "edit" }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, operation: "edit" });
}
