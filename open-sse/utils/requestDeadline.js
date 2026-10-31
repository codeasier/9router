import { CHAT_BUILD_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { randomUUID } from "node:crypto";

const REQUEST_ABORT_MESSAGES = {
  CHAT_BUILD_TIMEOUT: "Chat response preparation exceeded its time budget",
  CLIENT_DISCONNECTED: "Client disconnected",
  UPSTREAM_HEADERS_TIMEOUT: "Upstream response headers timed out",
};

export function createRequestAbortError(code = "CLIENT_DISCONNECTED") {
  const safeCode = Object.hasOwn(REQUEST_ABORT_MESSAGES, code) ? code : "CLIENT_DISCONNECTED";
  const error = new Error(REQUEST_ABORT_MESSAGES[safeCode]);
  error.name = safeCode === "CLIENT_DISCONNECTED" ? "AbortError" : "TimeoutError";
  error.code = safeCode;
  return error;
}

export function isRequestAbortError(error) {
  return !!error && Object.hasOwn(REQUEST_ABORT_MESSAGES, error.code);
}

export function isUpstreamHeadersTimeout(error) {
  // Fetch/dispatchers commonly wrap the actual transport error in `cause`.
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (current.code === "UND_ERR_HEADERS_TIMEOUT" || current.code === "UPSTREAM_HEADERS_TIMEOUT") return true;
  }
  return false;
}

// Never expose an incoming signal's arbitrary (potentially sensitive) reason.
export function requestAbortReason(signal) {
  return createRequestAbortError(isRequestAbortError(signal?.reason) ? signal.reason.code : "CLIENT_DISCONNECTED");
}

function signalReason(signal) {
  return signal?.reason ?? createRequestAbortError();
}

/** Race even non-cooperating operations; observe and clean up their late results. */
export function runWithSignal(signal, operation, onLateResult) {
  if (signal?.aborted) return Promise.reject(signalReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signalReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // The operation is invoked synchronously only after the listener is installed.
    // Promise handlers also consume late rejections, preventing unhandled errors.
    let pending;
    try { pending = operation(); } catch (error) { pending = Promise.reject(error); }
    Promise.resolve(pending).then(value => {
      if (settled) {
        try { Promise.resolve(onLateResult?.(value)).catch(() => {}); } catch { /* best effort */ }
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

/** Discarded/late responses must not keep an upstream connection alive. */
export function cancelResponseBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* already locked/closed */ }
}

export async function sleepWithSignal(signal, ms) {
  let timer;
  try {
    await runWithSignal(signal, () => new Promise(resolve => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }));
  } finally { clearTimeout(timer); }
}

/** One instance per incoming request, never stored on cached executors. */
export function createRequestDeadline({ signal, timeoutMs = CHAT_BUILD_TIMEOUT_MS, requestId } = {}) {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 2_147_483_647) : CHAT_BUILD_TIMEOUT_MS;
  const startedAt = Date.now();
  const expiresAt = startedAt + duration;
  // Internal correlation only. Do not log arbitrary incoming request-header values.
  const safeRequestId = typeof requestId === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(requestId) ? requestId : randomUUID();
  const controller = new AbortController();
  let building = true;
  let disposed = false;
  let attempt = 0;
  const abort = (error = createRequestAbortError()) => {
    if (!controller.signal.aborted) {
      controller.abort(createRequestAbortError(isRequestAbortError(error) ? error.code : "CLIENT_DISCONNECTED"));
    }
    clearTimeout(timer);
  };
  const timer = setTimeout(() => abort(createRequestAbortError("CHAT_BUILD_TIMEOUT")), duration);
  const onClientAbort = () => abort(requestAbortReason(signal));
  if (signal?.aborted) onClientAbort();
  else signal?.addEventListener("abort", onClientAbort, { once: true });

  const throwIfAborted = () => {
    // Check the clock as well: synchronous preprocessing may delay timer delivery.
    if (building && !disposed && Date.now() >= expiresAt && !controller.signal.aborted) {
      abort(createRequestAbortError("CHAT_BUILD_TIMEOUT"));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    requestId: safeRequestId,
    elapsedMs: () => Math.max(0, Date.now() - startedAt),
    nextAttempt: () => ++attempt,
    remainingMs: () => building ? Math.max(0, expiresAt - Date.now()) : Infinity,
    throwIfAborted,
    abort,
    run(operation, onLateResult) {
      try { throwIfAborted(); } catch (error) { return Promise.reject(error); }
      return runWithSignal(controller.signal, operation, onLateResult).then(value => {
        try { throwIfAborted(); } catch (error) {
          try { Promise.resolve(onLateResult?.(value)).catch(() => {}); } catch { /* best effort */ }
          throw error;
        }
        return value;
      });
    },
    async sleep(ms) {
      throwIfAborted();
      await sleepWithSignal(controller.signal, ms);
      throwIfAborted();
    },
    finish() {
      throwIfAborted();
      building = false;
      clearTimeout(timer);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onClientAbort);
    },
  };
}

/** Hand off the build budget while retaining cancellation for a healthy stream. */
export function finalizeResponseDeadline(response, deadline) {
  deadline.finish();
  if (!response?.body) {
    deadline.dispose();
    return response;
  }
  const reader = response.body.getReader();
  let ended = false;
  let onAbort;
  const cleanup = () => {
    deadline.signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* pending/non-standard reader */ }
    deadline.dispose();
  };
  const cancel = reason => {
    try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch { /* best effort */ }
  };
  const body = new ReadableStream({
    start(controller) {
      onAbort = () => {
        if (ended) return;
        ended = true;
        const error = requestAbortReason(deadline.signal);
        cancel(error);
        controller.error(error);
        cleanup();
      };
      deadline.signal.addEventListener("abort", onAbort, { once: true });
      if (deadline.signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const { done, value } = await runWithSignal(deadline.signal, () => reader.read());
        if (ended) return;
        if (done) {
          ended = true;
          controller.close();
          cleanup();
        } else controller.enqueue(value);
      } catch (error) {
        if (ended) return;
        ended = true;
        cancel(error);
        controller.error(error);
        cleanup();
      }
    },
    cancel(reason) {
      if (ended) return;
      ended = true;
      deadline.abort(createRequestAbortError("CLIENT_DISCONNECTED"));
      cancel(deadline.signal.reason);
      cleanup();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
