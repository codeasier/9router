import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "open-sse/handlers/imageProviders/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { enforceKeyPolicy, evaluateProviderBudget } from "../services/keyPolicy.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui", "veoaifree-web"]);

function recordImageRequestUsage({ provider, model, connectionId, apiKey, endpoint, usage }) {
  if (!usage || typeof usage !== "object") return;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 0) {
    return;
  }

  saveRequestUsage({
    provider,
    model,
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    tokens: usage,
    status: "success",
  }).catch(() => {});
}

/**
 * Handle image generation request
 * @param {Request} request
 */
export async function handleImageGeneration(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  // Per-key policy guard (entry)
  const policyGuard = await enforceKeyPolicy(apiKey, null);
  if (!policyGuard.ok) return policyGuard.response;

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Per-key access control: requested target, before combo expansion.
  const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request), modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return policyGuard.wrap(await handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    }));
  }

  return policyGuard.wrap(await handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname }));
}

/**
 * Shared single-model image execution (generation or edit) — also used by the
 * image edits handler. Validates credentials and drives account fallback.
 * @param {object} body - Parsed request body
 * @param {string} modelStr - Model or combo string
 * @param {object} [options]
 * @param {boolean} [options.wantsStream]
 * @param {boolean} [options.binaryOutput]
 * @param {string} [options.preferredConnectionId]
 * @param {string} [options.apiKey]
 * @param {string} [options.endpoint]
 * @param {string} [options.operation] - "generation" (default) or "edit"
 * @param {string} [options.apiKey] - client API key for per-provider budget checks
 */
export async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, operation = "generation", apiKey = null, endpoint } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  const budgetPolicy = await evaluateProviderBudget(apiKey, provider, {
    operation: operation === "edit" ? "image edit" : "image generation",
  });
  if (budgetPolicy.rejectionResponse) return budgetPolicy.rejectionResponse;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
      operation,
    });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Skip accounts the adapter knows cannot generate images (e.g. ChatGPT Free on codex)
    // without locking them: they stay usable for chat.
    const adapter = getImageAdapter(provider);
    if (adapter?.canUseCredentials && !adapter.canUseCredentials(refreshedCredentials)) {
      log.info("IMAGE", `[${provider}/${model}] skip connection ${credentials.connectionId.slice(0, 8)}: plan not entitled to image generation`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = lastError || "No account entitled to image generation (ChatGPT Free plans are not supported)";
      lastStatus = lastStatus || HTTP_STATUS.FORBIDDEN;
      continue;
    }

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      operation,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onUsage: (usage) => {
        recordImageRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint,
          usage,
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // Cookies that rotate on use (Clerk `__client`) are mutated in place by
        // the executor — persist the new value so the chain does not drift.
        if (refreshedCredentials.apiKey && refreshedCredentials.apiKey !== credentials.apiKey) {
          await updateProviderCredentials(credentials.connectionId, { apiKey: refreshedCredentials.apiKey });
        }
      }
    });

    if (result.success) return result.response;

    if (result.shouldFallback === false) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
