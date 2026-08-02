// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { editsUrlFrom } from "./_base.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: () => imageUrl(providerId),
    buildEditUrl: () => editsUrlFrom(imageUrl(providerId)),
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildEditBody: (model, body) => {
      const images = body.images || (body.image ? [body.image] : []);
      if (images.length === 0) throw new Error("Missing required field: image");
      const allowed = Array.isArray(cfg.bodyFields) ? new Set(cfg.bodyFields) : null;
      const maySend = (field) => !allowed || allowed.has(field);

      const fd = new FormData();
      fd.append("model", model);
      images.forEach((img, i) => {
        if (!img?.b64) throw new Error("image must contain base64 data");
        const mime = img.mime || "image/png";
        const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
        fd.append("image", new Blob([Buffer.from(img.b64, "base64")], { type: mime }), img.name || `image${i + 1}.${ext}`);
      });
      fd.append("prompt", body.prompt);
      if (maySend("n") && body.n !== undefined) fd.append("n", String(body.n));
      if (maySend("size") && body.size) fd.append("size", String(body.size));
      if (maySend("response_format") && body.response_format) fd.append("response_format", String(body.response_format));
      if (maySend("mask") && body.mask?.b64) {
        fd.append("mask", new Blob([Buffer.from(body.mask.b64, "base64")], { type: body.mask.mime || "image/png" }), body.mask.name || "mask.png");
      }
      return fd;
    },
    buildBody: (model, body) => {
      const { prompt, n = 1, size = "1024x1024", quality, style, response_format } = body;
      const full = { model, prompt, n, size };
      if (quality) full.quality = quality;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      // bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
      if (Array.isArray(cfg.bodyFields)) {
        const req = {};
        for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
