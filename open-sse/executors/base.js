import { HTTP_STATUS, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  cancelResponseBody, createRequestAbortError, createRequestDeadline,
  finalizeResponseDeadline, isRequestAbortError, isUpstreamHeadersTimeout, requestAbortReason, runWithSignal, sleepWithSignal,
} from "../utils/requestDeadline.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  getHeadersTimeoutMs() {
    const configured = this.config?.timeoutMs;
    return Number.isFinite(configured) && configured > 0 ? configured : FETCH_CONNECT_TIMEOUT_MS;
  }

  getProxyLogMode(proxyOptions) {
    return proxyOptions?.vercelRelayUrl ? "relay"
      : proxyOptions?.enabled || proxyOptions?.connectionProxyEnabled ? "connection-configured"
      : process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
        || process.env.ALL_PROXY || process.env.all_proxy ? "environment-configured" : "direct";
  }

  async execute(args) {
    const ownedDeadline = !args.requestDeadline;
    const requestDeadline = args.requestDeadline || createRequestDeadline({ signal: args.signal });
    let result;
    try {
      result = await this._executeWithDeadline({ ...args, requestDeadline });
      if (ownedDeadline) {
        if (args.signal) result.response = finalizeResponseDeadline(result.response, requestDeadline);
        else { requestDeadline.finish(); requestDeadline.dispose(); }
      }
      return result;
    } catch (error) {
      cancelResponseBody(result?.response);
      if (ownedDeadline) {
        requestDeadline.abort(error);
        requestDeadline.dispose();
      }
      throw error;
    }
  }

  async _executeWithDeadline({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null, requestDeadline }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    let attempt = 0;
    let attemptStartedAt = Date.now();
    const retryAttemptsByUrl = {};
    const requestSignal = signal && signal !== requestDeadline.signal
      ? AbortSignal.any([signal, requestDeadline.signal]) : requestDeadline.signal;
    const checkAborted = () => {
      requestDeadline.throwIfAborted();
      if (requestSignal.aborted) throw requestAbortReason(requestSignal);
    };
    const run = (operation, onLateResult) => {
      checkAborted();
      return runWithSignal(requestSignal, operation, onLateResult);
    };
    // Report configured routing only, never proxy addresses, request data or raw causes.
    const proxyMode = this.getProxyLogMode(proxyOptions);
    const fetchLog = (phase, extra = "") => log?.info?.("FETCH",
      `request=${requestDeadline.requestId} provider=${this.provider.toUpperCase()} attempt=${attempt} total_elapsed=${requestDeadline.elapsedMs()}ms attempt_elapsed=${Date.now() - attemptStartedAt}ms remaining=${requestDeadline.remainingMs()}ms phase=${phase} proxy=${proxyMode}${extra}`);
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await run(() => this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs));
        if (dynamic === false) return false;
        if (dynamic != null) waitMs = dynamic;
      }
      checkAborted();
      retryAttemptsByUrl[urlIndex]++;
      cancelResponseBody(response);
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      fetchLog("backoff");
      // The composed signal also includes the core stream controller.
      await sleepWithSignal(requestSignal, waitMs);
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      checkAborted();
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model, transformedBody);
      if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);
      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Headers, not merely TCP connect: never restart a slow prefill on expiry.
      const headersController = new AbortController();
      const timeoutMs = Math.min(this.getHeadersTimeoutMs(), requestDeadline.remainingMs());
      const headersTimer = setTimeout(() => headersController.abort(createRequestAbortError("UPSTREAM_HEADERS_TIMEOUT")), timeoutMs);
      const fetchSignal = AbortSignal.any([requestSignal, headersController.signal]);
      let response;
      attempt = requestDeadline.nextAttempt();
      attemptStartedAt = Date.now();
      try {
        checkAborted();
        fetchLog("fetch_start", ` headers_timeout=${timeoutMs}ms`);
        response = await runWithSignal(fetchSignal, () => proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal: fetchSignal,
        }, proxyOptions), cancelResponseBody);
        clearTimeout(headersTimer);
        checkAborted();
        fetchLog("headers_received", ` status=${response.status}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) { urlIndex--; continue; }
        if (this.shouldRetry(response.status, urlIndex)) {
          cancelResponseBody(response);
          log?.debug?.("RETRY", `${response.status}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }
        return { response, url, headers, transformedBody, fetchAttempt: attempt, fetchStartedAt: attemptStartedAt };
      } catch (caught) {
        clearTimeout(headersTimer);
        cancelResponseBody(response);
        let error = caught;
        if (requestSignal.aborted) error = requestAbortReason(requestSignal);
        else if (headersController.signal.aborted || isUpstreamHeadersTimeout(caught)) {
          error = createRequestAbortError("UPSTREAM_HEADERS_TIMEOUT");
        }
        lastError = error;
        const cause = isRequestAbortError(error) ? error.code : "network_error";
        fetchLog("fetch_failed", ` cause=${cause}`);
        // Classification uses signal state/codes, not an implementation-specific name.
        if (isRequestAbortError(error) || error?.name === "AbortError") throw error;
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, "network failure")) { urlIndex--; continue; }
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Network failure, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(headersTimer);
      }
    }
    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }

}

export default BaseExecutor;
