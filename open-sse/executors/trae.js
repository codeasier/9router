import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDERS } from "../config/providers.js";
import {
  TRAE_CHAT_PATH,
  aggregateChatCompletion,
  bridgeTraeStream,
  buildTraeChatHeaders,
  classifyTraeFailure,
  loadTraeCatalog,
  prepareSoloBody,
  redactTraeHeaders,
  resolveWireTarget,
  separateLeadingTraeFailure,
  traeRoute,
} from "../services/traeSolo.js";

// Trae SOLO chat. One executor class, three provider ids. The provider id pins
// the gateway: personal CN, international, or enterprise. Enterprise never
// falls back onto the personal gateway.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function httpStatusForUpstream(status) {
  if (status === 401 || status === 403) return 401;
  if (status === 402) return 402;
  if (status === 429) return 429;
  if (status >= 400 && status < 500) return 400;
  return 502;
}

export class TraeSoloExecutor extends BaseExecutor {
  constructor(provider, fetchImpl) {
    super(provider, PROVIDERS[provider] || {});
    this.fetchImpl = fetchImpl || ((url, options) => proxyAwareFetch(url, options, null));
  }

  failure(status, message, url, headers, transformedBody) {
    return {
      response: jsonResponse(status, { error: { message, type: "api_error", code: "" } }),
      url,
      headers: redactTraeHeaders(headers || {}),
      transformedBody,
      responseFormat: "openai",
    };
  }

  async execute({ model, body, stream, credentials, signal }) {
    const route = traeRoute(this.provider);
    const headers = buildTraeChatHeaders(credentials);
    const url = `${route.chatBase}${TRAE_CHAT_PATH}`;
    if (!credentials?.accessToken && !credentials?.apiKey) {
      return this.failure(401, "Trae connection has no access token", url, headers, body);
    }
    let catalog = [];
    if (!signal?.aborted) {
      try {
        catalog = await loadTraeCatalog({
          fetchImpl: this.fetchImpl,
          headers,
          route,
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        catalog = [];
      }
    }
    let solo;
    try {
      solo = prepareSoloBody(body || {}, { wire: resolveWireTarget(catalog, model), enterprise: route.enterprise });
    } catch (error) {
      return this.failure(400, error?.message || "Invalid Trae request", url, headers, body);
    }

    let upstream;
    try {
      upstream = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(solo),
        signal,
      });
    } catch (error) {
      return this.failure(502, error?.message ? String(error.message) : "Trae request failed", url, headers, solo);
    }
    if (!upstream?.ok) {
      const text = upstream ? await upstream.text().catch(() => "") : "";
      return this.failure(
        httpStatusForUpstream(upstream?.status || 502),
        text.slice(0, 500) || `Trae HTTP ${upstream?.status || 0}`,
        url,
        headers,
        solo,
      );
    }

    const opened = await separateLeadingTraeFailure(upstream);
    if (opened.failure) {
      const classified = classifyTraeFailure(opened.failure);
      return this.failure(classified.status, classified.message, url, headers, solo);
    }

    const sseResponse = bridgeTraeStream(opened.stream, solo.model);
    if (stream === false) {
      const text = await sseResponse.text();
      const aggregated = aggregateChatCompletion(text, solo.model);
      if (aggregated.error) {
        return this.failure(502, aggregated.error.message || "Trae request failed", url, headers, solo);
      }
      return {
        response: jsonResponse(200, aggregated.completion),
        url,
        headers: redactTraeHeaders(headers),
        transformedBody: solo,
        responseFormat: "openai",
      };
    }
    return {
      response: sseResponse,
      url,
      headers: redactTraeHeaders(headers),
      transformedBody: solo,
      responseFormat: "openai",
    };
  }
}

export default class TraeExecutor extends TraeSoloExecutor {
  constructor(fetchImpl) {
    super("trae", fetchImpl);
  }
}
