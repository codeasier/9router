import { handleChat } from "@/sse/handlers/chat.js";
import {
  clearAccountError,
  getProviderCredentials,
  isValidApiKey,
  markAccountUnavailable,
} from "@/sse/services/auth.js";
import { getSettings } from "@/lib/localDb";
import { PROVIDER_MODELS } from "@/shared/constants/models";
import { GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS } from "open-sse/config/runtimeConfig.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "@/sse/services/keyAccess.js";

let initialized = false;
const GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// Gemini model id charset (matches sanitizeGeminiFunctionName); blocks path traversal in upstream URL.
const GEMINI_NATIVE_MODEL_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

// Method suffix on the URL, per the Gemini HTTP convention. Anything else is a
// 404 rather than being coerced into generateContent with the suffix glued onto
// the model name.
const GEMINI_ACTION_PATTERN = /:(streamGenerateContent|generateContent|countTokens|embedContent|batchEmbedContents|computeTokens|predict)$/;

// HTTP status → Google API error status string.
const GOOGLE_ERROR_STATUS = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

function googleError(message, status = 400) {
  return Response.json(
    { error: { code: status, message, status: GOOGLE_ERROR_STATUS[status] || "UNKNOWN" } },
    { status, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

/**
 * GET /v1beta/models/{model} (and /v1beta/models/{provider}/{model})
 *
 * Google SDKs call this to describe a model. Returning metadata keeps
 * `client.models.get()` working; without it Next answers 405 and some clients
 * abort before the first chat request.
 */
export async function GET(_request, { params }) {
  const { path } = await params;
  const requested = (path || []).join("/").replace(/:.*$/, "");
  if (!requested) return googleError("Missing model in URL", 400);

  const segments = requested.split("/");
  let provider = null;
  let entry = null;

  if (segments.length >= 2) {
    provider = segments[0];
    const modelId = segments.slice(1).join("/");
    entry = (PROVIDER_MODELS[provider] || []).find((model) => model.id === modelId) || null;
  } else {
    entry = Object.values(PROVIDER_MODELS)
      .flat()
      .find((model) => model.id === requested) || null;
  }

  if (!entry) {
    return googleError(`Model not found: ${requested}`, 404);
  }

  return Response.json(
    {
      name: `models/${requested}`,
      displayName: entry.name || entry.id,
      description: provider ? `${provider} model: ${entry.name || entry.id}` : undefined,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      inputTokenLimit: 128000,
      outputTokenLimit: 8192,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

/**
 * The Gemini endpoint is a native passthrough.
 *
 * The client body is a GenerateContentRequest and is handed to `handleChat`
 * untouched apart from the routing fields (`model`, `stream`). The engine then
 * picks one of two paths:
 *
 *   - Gemini-family target (antigravity, gemini-cli, gemini, vertex): a direct
 *     `gemini:target` translator only places the payload inside the vendor
 *     envelope, so `tools`, `inlineData`, `responseSchema` and thought
 *     signatures survive end to end.
 *   - Any other target (combo members on another wire): the regular
 *     Gemini → OpenAI → target bridge runs, and the answer comes back through
 *     the `openai:gemini` response translator.
 *
 * Nothing is rebuilt into `messages[]` here, which is what previously dropped
 * tool declarations and inline media.
 */
export async function POST(request, { params }) {
  await ensureInitialized();

  try {
    const { path } = await params;
    // path = ["provider", "model:action"] or ["model:action"];
    // combos and bare model ids are single-segment names too.

    if (!Array.isArray(path) || path.length === 0) {
      return googleError("Missing model in URL", 400);
    }

    const modelAction = String(path[path.length - 1] || "");
    const actionMatch = modelAction.match(GEMINI_ACTION_PATTERN);
    if (!actionMatch) {
      return googleError(`Unsupported method on model "${modelAction}"`, 404);
    }

    const action = `:${actionMatch[1]}`;
    const modelName = modelAction.slice(0, actionMatch.index);
    if (!modelName) {
      return googleError("Missing model in URL", 400);
    }

    // /v1beta/models/{provider}/{model}:generateContent addresses a provider
    // explicitly; /v1beta/models/{model}:generateContent addresses a combo or a
    // bare model id.
    const model = path.length >= 2 ? `${path[0]}/${modelName}` : modelName;

    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return googleError("Request body must be a JSON object", 400);
    }

    if (isGeminiNativeTtsRequest(model, body)) {
      return await forwardGeminiNativeRequest(request, body, model, action);
    }

    if (action === ":countTokens" || action === ":computeTokens") {
      return googleError("countTokens is not supported by 9router", 400);
    }
    if (action === ":embedContent" || action === ":batchEmbedContents") {
      return googleError("Use POST /v1/embeddings for embeddings", 400);
    }
    if (action === ":predict") {
      return googleError("predict is not supported by 9router", 400);
    }

    // Streaming intent comes from the URL action suffix (canonical Gemini
    // convention); generationConfig has no stream field.
    const stream = action === ":streamGenerateContent";

    const routedBody = { ...body, model, stream };

    const newRequest = new Request(request.url, {
      signal: request.signal,
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(routedBody),
    });

    const response = await handleChat(newRequest);
    return withCors(await shapeGoogleError(response));
  } catch (error) {
    console.log("Error handling Gemini request:", error);
    return googleError(error.message || "Internal error", 500);
  }
}

/** Keep the Gemini endpoint's CORS contract regardless of which layer answered. */
function withCors(response) {
  const headers = new Headers(response.headers);
  if (!headers.has("Access-Control-Allow-Origin")) {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Gemini SDKs parse Google error envelopes; the engine answers in OpenAI shape.
 * Preserve Google envelopes (errors already coming from an upstream Gemini call)
 * and translate everything else.
 */
async function shapeGoogleError(response) {
  if (response.ok) return response;

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (payload?.error?.code !== undefined && payload?.error?.status) {
    return response;
  }

  const rawMessage = payload?.error?.message ?? payload?.error ?? payload?.message;
  const message = typeof rawMessage === "string" && rawMessage
    ? rawMessage
    : `Upstream request failed (${response.status})`;

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.delete("content-length");
  return new Response(
    JSON.stringify({
      error: {
        code: response.status,
        message,
        status: GOOGLE_ERROR_STATUS[response.status] || "UNKNOWN",
      },
    }),
    { status: response.status, statusText: response.statusText, headers }
  );
}

function extractGeminiClientApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const googleApiKey = request.headers.get("x-goog-api-key");
  if (googleApiKey) return googleApiKey;

  const url = new URL(request.url);
  return url.searchParams.get("key");
}

function normalizeGeminiNativeModel(model) {
  return String(model || "")
    .replace(/^models\//, "")
    .replace(/^gemini\//, "");
}

function getGeminiTtsModelIds() {
  return new Set([
    ...(PROVIDER_MODELS.gemini || [])
      .filter((model) => (model.kind || model.type) === "tts")
      .map((model) => model.id),
    ...(PROVIDER_MODELS["gemini-tts-models"] || []).map((model) => model.id),
  ]);
}

function hasAudioResponseModality(body) {
  const modalities = body?.generationConfig?.responseModalities;
  return Array.isArray(modalities)
    && modalities.some((modality) => String(modality).toUpperCase() === "AUDIO");
}

function isGeminiNativeTtsRequest(model, body) {
  const rawModel = String(model || "");
  if (rawModel.includes("/") && !rawModel.startsWith("gemini/") && !rawModel.startsWith("models/")) {
    return false;
  }

  const modelId = normalizeGeminiNativeModel(model);
  return hasAudioResponseModality(body) || getGeminiTtsModelIds().has(modelId);
}

function buildGeminiNativeUrl(requestUrl, model, action) {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(`${GEMINI_NATIVE_BASE_URL}/${normalizeGeminiNativeModel(model)}${action}`);

  for (const [key, value] of sourceUrl.searchParams.entries()) {
    if (key === "key") continue;
    upstreamUrl.searchParams.append(key, value);
  }

  return upstreamUrl.toString();
}

async function validateGeminiNativeClientKey(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;

  const apiKey = extractGeminiClientApiKey(request);
  if (!apiKey) {
    return Response.json({ error: { message: "Missing API key" } }, { status: 401 });
  }

  const valid = await isValidApiKey(apiKey);
  if (!valid) {
    return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
  }

  return null;
}

function buildGeminiNativeAuthHeaders(credentials) {
  if (credentials?.apiKey) return { "x-goog-api-key": credentials.apiKey };
  if (credentials?.accessToken) return { Authorization: `Bearer ${credentials.accessToken}` };
  return null;
}

function corsHeadersFrom(response) {
  const headers = new Headers(response.headers);
  // Node fetch may expose a decoded body while preserving upstream compression
  // headers. Forwarding those headers makes clients decompress plain bytes again.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function getSafeGeminiConnectionLabel(credentials) {
  const connectionId = String(credentials?.connectionId || "unknown");
  const shortId = connectionId.slice(0, 8);
  const connectionName = String(credentials?.connectionName || "");
  if (!connectionName || connectionName.includes("@")) return shortId;
  return `${connectionName}:${shortId}`;
}

function getGeminiNativeErrorCode(error) {
  return error?.cause?.code || error?.code || error?.cause?.name || error?.name || "UNKNOWN";
}

function isGeminiNativeTimeoutError(error, timedOut) {
  if (timedOut) return true;
  const code = getGeminiNativeErrorCode(error);
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "HeadersTimeoutError";
}

function getSafeGeminiNativeErrorText(error) {
  const message = error?.message || String(error);
  const code = getGeminiNativeErrorCode(error);
  return `${message} (${code})`;
}

async function forwardGeminiNativeRequest(request, body, model, action) {
  const authError = await validateGeminiNativeClientKey(request);
  if (authError) return authError;

  const modelId = normalizeGeminiNativeModel(model);
  if (!GEMINI_NATIVE_MODEL_PATTERN.test(modelId)) {
    return Response.json({ error: { message: "Invalid model" } }, { status: 400 });
  }

  // Per-key access control: this path calls Gemini directly (not via handleChat),
  // so restricted keys are checked here, before any credential lookup.
  const keyAccessDenied = await enforceKeyAccessResolved(await getKeyAccessContext(request), model, "gemini", modelId);
  if (keyAccessDenied) return keyAccessDenied;
  const excludeConnectionIds = new Set();
  const bodyText = JSON.stringify(body);
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials("gemini", excludeConnectionIds, modelId);
    if (!credentials || credentials.allRateLimited) {
      console.log(`[GEMINI_NATIVE] exhausted model=${modelId} status=${lastStatus || Number(credentials?.lastErrorCode) || 503} error=${lastError || credentials?.lastError || "No active credentials for provider: gemini"}`);
      return Response.json(
        { error: { message: lastError || credentials?.lastError || "No active credentials for provider: gemini" } },
        { status: lastStatus || Number(credentials?.lastErrorCode) || 503 }
      );
    }

    const authHeaders = buildGeminiNativeAuthHeaders(credentials);
    if (!authHeaders) {
      return Response.json(
        { error: { message: "No Gemini API key configured" } },
        { status: 404 }
      );
    }

    const safeConnection = getSafeGeminiConnectionLabel(credentials);
    const startedAt = Date.now();
    const upstreamUrl = buildGeminiNativeUrl(request.url, modelId, action);
    const attemptController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS);
    const abortAttempt = () => attemptController.abort();

    if (request.signal?.aborted) {
      console.log(`[GEMINI_NATIVE] client aborted model=${modelId} ms=0 conn=${safeConnection}`);
      return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
    }

    request.signal?.addEventListener("abort", abortAttempt, { once: true });
    console.log(`[GEMINI_NATIVE] start model=${modelId} action=${action} conn=${safeConnection} body=${Buffer.byteLength(bodyText)}B timeout=${GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS}`);

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": request.headers.get("Content-Type") || "application/json",
          ...authHeaders,
        },
        body: bodyText,
        signal: attemptController.signal,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (request.signal?.aborted && !timedOut) {
        console.log(`[GEMINI_NATIVE] client aborted model=${modelId} ms=${durationMs} conn=${safeConnection}`);
        return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
      }

      const status = isGeminiNativeTimeoutError(error, timedOut) ? 504 : 502;
      const errorText = getSafeGeminiNativeErrorText(error);
      console.log(`[GEMINI_NATIVE] fetch failed model=${modelId} status=${status} ms=${durationMs} conn=${safeConnection} error=${errorText}`);

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId,
        status,
        errorText,
        "gemini",
        modelId
      );

      if (shouldFallback) {
        excludeConnectionIds.add(credentials.connectionId);
        lastError = errorText;
        lastStatus = status;
        console.log(`[GEMINI_NATIVE] fallback model=${modelId} status=${status} conn=${safeConnection} exclude=${excludeConnectionIds.size}`);
        continue;
      }

      return Response.json({ error: { message: errorText } }, { status });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortAttempt);
    }

    console.log(`[GEMINI_NATIVE] upstream model=${modelId} status=${upstreamResponse.status} ms=${Date.now() - startedAt} conn=${safeConnection} ct=${upstreamResponse.headers.get("content-type") || "?"} cl=${upstreamResponse.headers.get("content-length") || "?"}`);

    if (upstreamResponse.ok) {
      await clearAccountError(credentials.connectionId, credentials, modelId);
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: corsHeadersFrom(upstreamResponse),
      });
    }

    const errorText = await upstreamResponse.text();
    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      upstreamResponse.status,
      errorText,
      "gemini",
      modelId
    );

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = errorText;
      lastStatus = upstreamResponse.status;
      continue;
    }

    return new Response(errorText, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: corsHeadersFrom(upstreamResponse),
    });
  }
}
