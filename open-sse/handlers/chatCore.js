import { detectFormat } from "../services/provider.js";
import { resolveChatRouting } from "../services/modelOverrides.js";
import { translateRequest } from "../translator/index.js";
import { applyThinking, extractThinking, stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude.js";
import { createStreamController } from "../utils/streamHandler.js";
import { createRequestDeadline, createRequestAbortError, isRequestAbortError, cancelResponseBody, finalizeResponseDeadline } from "../utils/requestDeadline.js";
import { buildCredentialProxyOptions } from "../utils/proxyFetch.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { upstreamResponseHeaders } from "../utils/upstreamHeaders.js";
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { supportsGrokCliReasoningEffort } from "../config/grokCli.js";
import { readResponseBody } from "../utils/readResponseBody.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { takeRenamedToolNames } from "../utils/opencodeFingerprint.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { injectCustomPrompt } from "../rtk/customPrompt.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog, isHeadroomPhantomSavings } from "../rtk/headroom.js";
import { compressWithPxpipe } from "../rtk/pxpipe.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";
import { defaultClaudeToolType, shouldDefaultClaudeToolType } from "../translator/concerns/toolCall.js";
import { resolveSessionId } from "../utils/sessionManager.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

// The app owns one deadline across account/combo fallback. Standalone engine
// callers get the same lifecycle, but only its owner may finish/dispose it.
export async function handleChatCore(options) {
  const requestDeadline = options.requestDeadline || createRequestDeadline({ signal: options.signal });
  const ownsDeadline = !options.requestDeadline;
  const state = { streamController: null, providerResponse: null, streaming: false, trackDone: () => {} };
  try {
    const result = await requestDeadline.run(() => handleChatCoreAttempt({ ...options, requestDeadline, requestState: state }), (late) => cancelResponseBody(late?.response));
    requestDeadline.throwIfAborted();
    if (!state.streaming) {
      state.trackDone();
      state.streamController?.handleComplete();
    }
    if (ownsDeadline) {
      if (result?.response) result.response = finalizeResponseDeadline(result.response, requestDeadline);
      else requestDeadline.dispose();
    }
    return result;
  } catch (error) {
    if (error?.name === "AbortError" && !isRequestAbortError(error)) error = createRequestAbortError("CLIENT_DISCONNECTED");
    if (isRequestAbortError(error)) error = createRequestAbortError(error.code);
    if (ownsDeadline && isRequestAbortError(error)) requestDeadline.abort(error);
    state.streamController?.abort?.(error);
    state.streamController?.handleComplete();
    cancelResponseBody(state.providerResponse);
    if (ownsDeadline) requestDeadline.dispose();
    state.trackDone();
    if (!isRequestAbortError(error)) throw error;
    const { provider, model } = options.modelInfo;
    const status = error.code === "CLIENT_DISCONNECTED" ? 499 : HTTP_STATUS.GATEWAY_TIMEOUT;
    appendRequestLog({ model, provider, connectionId: options.connectionId, status: `FAILED ${status}` }).catch(() => {});
    // Local cancellation is terminal, not an unhealthy provider/account. Keep
    // the typed marker in-process; never echo the client's arbitrary reason.
    return { ...createErrorResult(status, error.message), terminalRequestError: error };
  }
}

async function handleChatCoreAttempt({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, headroomEnabled, headroomUrl, headroomCompressUserMessages, headroomTimeoutMs, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, customPromptEnabled, customPrompt, pxpipeEnabled, pxpipeMinChars, pxpipeTimeoutMs, pxpipeTransform, onPxpipeEvent, sourceFormatOverride, providerThinking, providerOverrides, modelOverrides, allowCodexSseFallback = true, requestDeadline, requestState }) {
  requestDeadline.throwIfAborted();
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();
  // Stable per-session color so all lines of one CLI conversation share a tag
  const sessionSeed = (() => {
    try {
      return resolveSessionId({ headers: clientRawRequest?.headers, body, connectionId, scope: provider });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession ? log.tagForSession(sessionSeed) : (log?.nextTag ? log.nextTag() : "");

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const { targetFormat, useTransport, thinkingIntent: forcedThinking, override } = resolveChatRouting({
    provider,
    model,
    sourceFormat,
    credentials,
    settings: { modelOverrides },
    log,
  });
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  if (override?.protocol && useTransport) {
    log?.info?.("OVERRIDE", `protocol ${override.protocol} → ${useTransport.baseUrl}`);
  }
  const stripList = getModelStrip(alias, model);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  // Per-model gateway force (forcedThinking) already wins later via applyThinking.
  if (!forcedThinking && providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  // Tiered upstream ids must use the same gateway-forced intent as translation,
  // including precedence over a client effort or model suffix.
  let upstreamThinkingBody = body;
  if (forcedThinking) {
    upstreamThinkingBody = {};
    applyThinking(FORMATS.OPENAI, model, upstreamThinkingBody, provider, forcedThinking);
  }
  const upstreamModel = getModelUpstreamId(alias, forcedThinking ? stripThinkingSuffix(model) : model, upstreamThinkingBody);

  // Per-request opt-out: client can bypass all token savers via header
  const tokenSaverEnabled = clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() !== "off";

  // Cursor's translator rewrites tool_result into user text, so RTK must run on
  // the source body before translation. Every other pair translates the tool
  // shapes 1:1 — keep the post-translate pass there so those providers are
  // untouched (and a retry never re-compresses an already-compressed body).
  const preTranslateRtk = provider === "cursor"
    ? compressMessages(body, tokenSaverEnabled && rtkEnabled)
    : null;
  const preTranslateRtkLine = formatRtkLog(preTranslateRtk);
  if (preTranslateRtkLine) console.log(preTranslateRtkLine);

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true;
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  const reqLogger = await requestDeadline.run(() => createRequestLogger(sourceFormat, targetFormat, model));
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);
  const effectiveAllowCodexSseFallback = provider === "codex" && clientTool === "codex" && passthrough
    ? allowCodexSseFallback
    : true;

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      const n = await requestDeadline.run(() => prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: requestDeadline.signal }));
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) {
      requestDeadline.throwIfAborted();
      if (isRequestAbortError(e)) throw e;
      log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`);
    }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) };
    if (provider === "codex") {
      const suffixThinking = {};
      applyThinking(sourceFormat, upstreamModel, suffixThinking, provider, forcedThinking);
      // applyThinking emits the wire shape for the source format: reasoning_effort
      // on chat wire, reasoning:{effort} on Responses wire. Read both.
      const suffixEffort = suffixThinking.reasoning_effort
        ?? (suffixThinking.reasoning && typeof suffixThinking.reasoning === "object" && !Array.isArray(suffixThinking.reasoning)
          ? suffixThinking.reasoning.effort
          : null);
      if (typeof suffixEffort === "string" && suffixEffort) {
        const reasoning = translatedBody.reasoning;
        translatedBody.reasoning = {
          ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
          effort: suffixEffort,
        };
        delete translatedBody.reasoning_effort;
      }
    }
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model);
  } else {
    // Only append the forced-thinking argument when an override is active, so the
    // call signature stays identical to upstream for the common path.
    translatedBody = await requestDeadline.run(() => forcedThinking
      ? translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool, forcedThinking)
      : translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool));
    if (!translatedBody) {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._customToolNames;
    translatedBody.model = stripThinkingSuffix(upstreamModel);
    stripContinuityFields(translatedBody);
  }

  // `stream` is 9router serialization, not a GenerateContentRequest field, and
  // Google validates unknown names strictly. A Gemini-native client body reaches
  // the upstream as-is (passthrough) or wrapped by an envelope builder, so drop
  // it here rather than in every executor.
  if (sourceFormat === FORMATS.GEMINI && translatedBody && typeof translatedBody === "object") {
    delete translatedBody.stream;
  }

  // Tool normalization: MCP-equivalent built-in dedup (Claude clients) + same-name
  // dedup for DeepSeek models (upstream rejects duplicate tool names on all endpoints).
  if (Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools, { clientTool, model });
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Request line: one correlated summary (fmt + thinking + counts + account)
  if (log?.line) {
    const clientModel = clientRawRequest?.body?.model || `${provider}/${model}`;
    const msgN = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || body.messages?.length || body.input?.length || 0;
    const toolN = translatedBody.tools?.length || body.tools?.length || 0;
    const fmtStr = passthrough ? `FMT: ${sourceFormat} (passthrough)` : `FMT: ${sourceFormat}→${targetFormat}`;
    const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model);
    const think = showThinking ? log.fmtThink?.(extractThinking(translatedBody)) : null;
    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const parts = [
      `POST ${clientModel} → ${provider}/${model}`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      `${msgN} MSG`,
    ];
    if (toolN) parts.push(`${toolN} TOOL`);
    if (think) parts.push(`THINK:${think}`);
    parts.push(`ACC:${acc}`);
    log.line(reqTag, "▶", parts.join(" · "));
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // Claude tool schema requires `type` to be explicitly set; strict gateways (e.g., MiniMax)
  // reject legacy payloads that omit it with HTTP 400. Default to "custom" when missing.
  // Provider-scoped via quirks (shouldDefaultClaudeToolType): only gateways that declare
  // requireClaudeToolType get the explicit type. Applying it unconditionally breaks
  // Claude-format endpoints that only accept the legacy typeless tool shape — DeepSeek's
  // Anthropic-compatible endpoint 400s with "unknown variant `custom`" (#3905).
  if (shouldDefaultClaudeToolType(provider, finalFormat, translatedBody.tools, PROVIDERS)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }

  // RTK: compress tool_result content. Skipped when already done pre-translate.
  const rtkStats = preTranslateRtk || compressMessages(translatedBody, tokenSaverEnabled && rtkEnabled);

  // Headroom: optional external proxy compression; fail open if proxy is absent.
  const headroomDiagnostics = {};
  const headroomStats = await requestDeadline.run(() => compressWithHeadroom(translatedBody, { enabled: tokenSaverEnabled && headroomEnabled, url: headroomUrl, model: upstreamModel, format: finalFormat, compressUserMessages: headroomCompressUserMessages, timeoutMs: headroomTimeoutMs, diagnostics: headroomDiagnostics, signal: requestDeadline.signal }));
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  if (headroomLine) {
    log?.info?.("HEADROOM", `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`);
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      log?.warn?.("HEADROOM", `reported token delta, but messages and outbound JSON shrank <5% | ${formatHeadroomSizeLog(headroomDiagnostics)}`);
    }
  } else if (tokenSaverEnabled && headroomEnabled) log?.warn?.("HEADROOM", `skipped: ${headroomDiagnostics.reason || "compression unavailable"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`);

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  if (rtkStats?.hits?.length) xf.push(`RTK:${rtkStats.hits.length}`);

  // Caveman: inject terse-style system prompt
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    xf.push(`CAVEMAN:${cavemanLevel}`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    xf.push(`PONYTAIL:${ponytailLevel}`);
  }

  // Custom prompt: user-authored instruction, independent of the savers above
  if (customPromptEnabled && injectCustomPrompt(translatedBody, finalFormat, customPrompt)) {
    xf.push(`CUSTOMPROMPT:${customPrompt.trim().length}c`);
  }

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  if (pxpipeEnabled) {
    const pxpipeResult = await requestDeadline.run(() => compressWithPxpipe(translatedBody, {
      enabled: true, format: finalFormat, model: upstreamModel,
      minChars: pxpipeMinChars, timeoutMs: pxpipeTimeoutMs, transform: pxpipeTransform, signal: requestDeadline.signal,
    }));
    pxpipeSummary = pxpipeResult.summary;
    if (pxpipeResult.body) translatedBody = pxpipeResult.body;
    if (pxpipeSummary?.applied) xf.push(`PXPIPE:${pxpipeSummary.imageCount}img`);
    try { onPxpipeEvent?.({ provider, model, ...pxpipeSummary }); } catch { /* stats must not break requests */ }
  }

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));

  // Pin cache breakpoints to the final body — every saver above can reshape
  // system/tools/messages, and a stale anchor costs a full prefix rewrite.
  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody);

  requestDeadline.throwIfAborted();
  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  let pending = true;
  const trackDone = (error = false) => {
    if (!pending) return;
    pending = false;
    trackPendingRequest(model, provider, connectionId, false, error);
  };
  requestState.trackDone = trackDone;
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    signal: requestDeadline.signal,
    onDisconnect: (reason) => {
      trackDone();
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackDone(),
    log, provider, model, reqTag
  });

  requestState.streamController = streamController;
  const proxyOptions = buildCredentialProxyOptions(credentials);

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl} | strict=${proxyOptions.strictProxy === true}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl} | strict=${proxyOptions.strictProxy === true}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  // Most executors return their registry format. Cursor AgentService is an
  // exception: it is decoded by the executor into OpenAI-compatible output.
  let providerResponseFormat = targetFormat;
  try {
    const result = await requestDeadline.run(() => executor.execute({
      model,
      body: translatedBody,
      stream,
      credentials,
      providerSessionId: sessionSeed,
      clientTool,
      signal: streamController.signal,
      requestDeadline,
      log,
      proxyOptions,
      providerOverrides,
      allowCodexSseFallback: effectiveAllowCodexSseFallback,
    }), (late) => cancelResponseBody(late?.response));
    providerResponse = requestState.providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    const renamedToolNames = takeRenamedToolNames(translatedBody);
    if (renamedToolNames?.size) {
      toolNameMap = new Map([...(toolNameMap || []), ...renamedToolNames]);
    }
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    requestDeadline.throwIfAborted();
    if (isRequestAbortError(error)) throw error;
    if (error?.name === "AbortError") throw createRequestAbortError("CLIENT_DISCONNECTED");
    trackDone(true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: HTTP_STATUS.BAD_GATEWAY, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    if (log?.errorLine) {
      log.errorLine(reqTag, "✗", `ERROR 502 · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error.stack ? `\n    ${error.stack}` : ""}`);
    }
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      // An already-started OAuth refresh may rotate the refresh token even
      // after its caller disconnects. Keep its persistence inside that operation,
      // outside the request race, so cancellation cannot discard the new token.
      // Executors retain their existing provider single-flight refresh behavior.
      const newCredentials = await requestDeadline.run(() => refreshWithRetry(async () => {
        const result = await executor.refreshCredentials(credentials, log, proxyOptions);
        if (result?.accessToken || result?.copilotToken || result?.refreshToken) {
          Object.assign(credentials, result);
          if (onCredentialsRefreshed) {
            try { await onCredentialsRefreshed(result); } catch (e) {
              log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`);
            }
          }
        }
        return result;
      }, 3, log, { requestDeadline }));
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line) log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        try {
          const retryResult = await requestDeadline.run(() => executor.execute({
            model,
            body: translatedBody,
            stream,
            credentials,
            providerSessionId: sessionSeed,
            clientTool,
            signal: streamController.signal,
            requestDeadline,
            log,
            proxyOptions,
            providerOverrides,
            allowCodexSseFallback: effectiveAllowCodexSseFallback,
          }), (late) => cancelResponseBody(late?.response));
          if (retryResult.response.ok) {
            cancelResponseBody(providerResponse);
            providerResponse = requestState.providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
          } else {
            cancelResponseBody(retryResult.response);
          }
        } catch (e) {
          requestDeadline.throwIfAborted();
          if (isRequestAbortError(e)) throw e;
          if (e?.name === "AbortError") throw createRequestAbortError("CLIENT_DISCONNECTED");
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      requestDeadline.throwIfAborted();
      if (isRequestAbortError(e)) throw e;
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  requestDeadline.throwIfAborted();
  // Provider returned error
  if (!providerResponse.ok) {
    const errorText = await readResponseBody(providerResponse, requestDeadline);
    const errorResponse = new Response(errorText, { status: providerResponse.status, headers: providerResponse.headers });
    const { statusCode, message, resetsAtMs } = await requestDeadline.run(() => parseUpstreamError(errorResponse, executor));
    trackDone(true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    if (log?.errorLine) {
      const urlStr = providerUrl ? `\n    URL: ${providerUrl}` : "";
      log.errorLine(reqTag, "✗", `ERROR ${statusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`);
    }
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs, upstreamResponseHeaders(providerResponse.headers));
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, requestDeadline, onRequestSuccess: onRequestSuccess ? () => {
    requestDeadline.throwIfAborted();
    return onRequestSuccess();
  } : undefined, pxpipe: pxpipeSummary, reqTag, log };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });

  // Provider forced streaming but client wants JSON. The Responses wire always
  // streams upstream (openaiToOpenAIResponsesRequest pins stream:true), so a
  // non-stream OpenAI/native client behind a Responses upstream must also take
  // this path — handleForcedSSEToJson returns null when the body is not SSE.
  if (!clientRequestedStreaming && (providerRequiresStreaming || providerResponseFormat === FORMATS.OPENAI_RESPONSES)) {
    const result = await requestDeadline.run(() => handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, customToolNames, toolNameMap, trackDone, appendLog }));
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await requestDeadline.run(() => handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, reqLogger, toolNameMap, customToolNames, trackDone, appendLog }));
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  const result = await requestDeadline.run(() => handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, userAgent, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, credentials, trackDone }), (late) => cancelResponseBody(late?.response));
  requestState.streaming = result.success && result.response?.headers.get("content-type")?.includes("text/event-stream");
  return result;
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
