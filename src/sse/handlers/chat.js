import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getAllowedComboModelIds } from "../services/modelAllowlist.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { resolveSmartChoice } from "../services/systemoneRouter.js";
import { withKeyPolicy, checkProviderBudgetResponse } from "../services/keyPolicy.js";
import { isManagementAuthenticated } from "@/dashboardGuard";
import {
  createRequestDeadline, isRequestAbortError, finalizeResponseDeadline, cancelResponseBody,
} from "open-sse/utils/requestDeadline.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  // One budget per inbound request, never per account/model/attempt. It ends at
  // downstream handoff, not at upstream headers (Codex and Combo can still peek).
  const requestDeadline = createRequestDeadline({ signal: request.signal });
  let response;
  try {
    response = await requestDeadline.run(
      () => handleChatWithinDeadline(request, clientRawRequest, requestDeadline),
      cancelResponseBody,
    );
    requestDeadline.throwIfAborted();
    log.info("CHAT", `request=${requestDeadline.requestId} total_elapsed=${requestDeadline.elapsedMs()}ms phase=downstream_started`);
    return finalizeResponseDeadline(response, requestDeadline);
  } catch (error) {
    cancelResponseBody(response);
    if (isRequestAbortError(error)) requestDeadline.abort(error);
    requestDeadline.dispose();
    if (!isRequestAbortError(error)) throw error;
    const status = error.code === "CLIENT_DISCONNECTED" ? 499 : HTTP_STATUS.GATEWAY_TIMEOUT;
    log.info("CHAT", `request=${requestDeadline.requestId} total_elapsed=${requestDeadline.elapsedMs()}ms phase=build_stopped reason=${error.code} status=${status}`);
    return errorResponse(status, error.message);
  }
}

async function handleChatWithinDeadline(request, clientRawRequest, requestDeadline) {
  let body;
  try {
    body = await requestDeadline.run(() => request.json());
  } catch (error) {
    if (isRequestAbortError(error)) throw error;
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  try {
    const { getCustomModels } = await import("@/lib/localDb");
    const { setCustomModelFormatOverlay } = await import("open-sse/config/customModelFormats.js");
    setCustomModelFormatOverlay(await requestDeadline.run(() => getCustomModels()));
  } catch (error) {
    if (isRequestAbortError(error)) throw error;
    // Overlay is best-effort; undeclared custom models keep legacy all-transport behavior.
  }

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await requestDeadline.run(() => getSettings());
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await requestDeadline.run(() => isValidApiKey(apiKey));
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  // Validate after authentication but before acquiring a concurrency lease.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Request body must be a JSON object");
  }
  if (body.model === undefined || body.model === null || body.model === "") {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Model must be a non-empty string");
  }
  // Claude Code's [1m] marker is an annotation, not part of the model id.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (!modelStr.trim()) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Model must be a non-empty string");
  }
  if (contextMarker) body.model = modelStr;

  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await requestDeadline.run(() => getKeyAccessContext(request));
  const keyAccessDenied = await requestDeadline.run(() => enforceKeyAccess(keyAccess, modelStr));
  if (keyAccessDenied) return keyAccessDenied;

  // Optional gate: allow only models GET /v1/models publishes (configured combos).
  // Runs before the key-policy lease so a rejected model never takes a slot.
  //
  // The gate is a policy for API *consumers*, not for the operator administering
  // them: the dashboard's per-model test and its example cards call these same
  // public endpoints by raw `provider/model`, so an admin would otherwise be
  // locked out of every model by a switch they set for somebody else. Requests
  // authenticated as the dashboard (session cookie) or as this instance's own
  // CLI/self-call (x-9r-cli-token) skip the gate; an ordinary API key does not.
  if (settings.allowComboModelsOnly && !(await requestDeadline.run(() => isManagementAuthenticated(request)))) {
    const allowedIds = await requestDeadline.run(() => getAllowedComboModelIds());
    // null = combos unreadable (DB down) -> fail open rather than reject everything.
    if (allowedIds && !allowedIds.includes(modelStr)) {
      log.warn("CHAT", `Model "${modelStr}" is not published by /v1/models — rejected (allowComboModelsOnly)`);
      return errorResponse(HTTP_STATUS.NOT_FOUND, `Model not found: ${modelStr}`);
    }
  }

  // Provider is unknown at entry; per-provider budgets are checked per attempt.
  return withKeyPolicy(apiKey, null, () => requestDeadline.run(async () => {
    // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
    const userAgent = request?.headers?.get("user-agent") || "";
    const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
    if (bypassResponse) return bypassResponse.response || bypassResponse;

    const requiredCapabilities = detectRequiredCapabilities(body);

    // Check if model is a combo (has multiple models with fallback)
    const comboModels = await requestDeadline.run(() => getComboModels(modelStr));
    if (comboModels) {
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = settings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
      const augmentedModels = await requestDeadline.run(() => filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels));
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return await handleFusionChat({
          requestDeadline,
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel, attemptDeadline = requestDeadline) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, comboModels.length > 1, attemptDeadline);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return await handleComboChat({
        requestDeadline,
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, augmentedModels.length > 1, requestDeadline),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({ body: b, models: m, routerModel: comboCfg.routerModel, log, requestDeadline })
          : null,
      });
    }

    // Single model request — may still switch to a capacity-adapter model if the
    // target lacks a capability the request needs (e.g. no vision, request has an image).
    const soloAugmented = await requestDeadline.run(() => filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]));
    if (soloAugmented.length > 1) {
      const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
      log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
      return await handleComboChat({
        requestDeadline,
        body,
        models: soloAugmented,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, soloAugmented.length > 1, requestDeadline),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
      });
    }

    return await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null, false, requestDeadline);
  }));
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, modelFallbackAvailable = false, requestDeadline) {
  requestDeadline.throwIfAborted();
  const modelInfo = await requestDeadline.run(() => getModelInfo(modelStr));

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await requestDeadline.run(() => getComboModels(modelStr));
    if (comboModels) {
      const chatSettings = await requestDeadline.run(() => getSettings());
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = await requestDeadline.run(() => getKeyAccessContext(request));
      const augmentedModels = await requestDeadline.run(() => filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels));
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          requestDeadline,
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel, attemptDeadline = requestDeadline) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, comboModels.length > 1, attemptDeadline);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      const nestedSessionId = nestedSession?.sessionId || null;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        requestDeadline,
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, augmentedModels.length > 1, requestDeadline),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId: nestedSessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              log,
              requestDeadline,
            })
          : null,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Per-attempt provider budget check (provider resolved here; entry guard
  // already handled whole-key breaker, "*" budgets and the concurrency slot)
  const budgetReject = await requestDeadline.run(() => checkProviderBudgetResponse(apiKey, provider));
  if (budgetReject) {
    log.warn("KEYPOLICY", `Budget exceeded for provider "${provider}" (key ${apiKey ? log.maskKey(apiKey) : "n/a"})`);
    return budgetReject;
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await requestDeadline.run(() => getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model }));

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await requestDeadline.run(() => checkAndRefreshToken(provider, credentials));

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await requestDeadline.run(() => getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider));
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await requestDeadline.run(() => getSettings());
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const modelOverrides = chatSettings.modelOverrides || {};
    const pxpipeTransform = chatSettings.pxpipeEnabled ? await requestDeadline.run(() => getPxpipeTransform()) : null;
    const result = await requestDeadline.run(() => handleChatCore({
      requestDeadline,
      signal: requestDeadline.signal,
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      customPromptEnabled: !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      modelOverrides,
      // A single-account, single-model route has no transparent fallback
      // target, so preserve the native Codex stream timing.
      allowCodexSseFallback: modelFallbackAvailable || refreshedCredentials.hasAlternateConnection === true,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    }), (late) => cancelResponseBody(late?.response));

    requestDeadline.throwIfAborted();
    if (result.terminalRequestError) throw result.terminalRequestError;
    if (result.success) return result.response;

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await requestDeadline.run(() => handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      ));
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await requestDeadline.run(() => markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs))).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
