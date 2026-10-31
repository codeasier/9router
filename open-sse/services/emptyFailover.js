// Detect a streamed completion that finished without ever producing usable
// content, so handleComboChat can fall through to the next candidate instead of
// returning a 200 that carries nothing.
//
// Why this exists: Gemini aborts a generation with finishReason MALFORMED_FUNCTION_CALL
// (the model attempts a native function call the API can't serialize). Upstream still
// returns HTTP 200 and streams a terminal frame with empty content, which the translator
// maps to finish_reason "stop". The combo's HTTP-status check then logs "succeeded" and
// the empty response reaches the client.
//
// The signal is STRUCTURAL, not an enum: "the stream ended and no content frame was ever
// released". That covers MALFORMED_FUNCTION_CALL, any future Gemini abort reason, and a
// stream that simply dies — with no reason vocabulary to keep in sync. The finish-reason
// enum is used only in the inverse: to NOT retry a legitimately-empty content-filter block.
//
// The peek must never become a buffer, though. A reasoning model emits thinking tokens for
// tens of seconds before its first answer character; if the peek waits for content, the client
// sees a frozen screen and then the entire response arrives in one burst (its first and last
// token land in the same instant, so any decode-rate meter reports a meaningless number while
// the user waited). So the peek releases the head as soon as the turn proves it is producing
// tokens — reasoning counts as proof. "Empty" is reserved for a stream that released nothing
// at all before it ended, which is exactly the 200-with-no-payload case this file exists for.

import {
  NO_RETRY_EMPTY_FINISH, OPENAI_FINISH, RESPONSES_STATUS, RESPONSES_INCOMPLETE_REASON,
} from "../translator/schema/finishReasons.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { CLAUDE_EVENT, CLAUDE_DELTA, RESPONSES_EVENT, RESPONSES_EVENT_PREFIX } from "../translator/schema/streamEvents.js";
import { toOpenAIFinish } from "../translator/concerns/finishReason.js";
import { FORMATS } from "../translator/formats.js";
import { EMPTY_PEEK_DEADLINE_MS } from "../config/runtimeConfig.js";
import { parseSSELine } from "../utils/streamHelpers.js";
import { isRequestAbortError } from "../utils/requestDeadline.js";

// OpenAI chat content test. A chunk counts as content only if it carries
// assistant output the caller can consume:
//   * delta.content (non-empty string, or non-empty array of parts)
//   * delta.tool_calls (a real tool call)
// It deliberately does NOT count:
//   * delta.role — 9router emits {role:"assistant"} on the first frame regardless of
//     content; treating it as content would defeat the whole check (and A0's own retry,
//     which is gated on "no chunk received yet").
//   * reasoning_content / delta.reasoning — a think-then-abort produces reasoning only,
//     which A0 treats as an unusable-but-non-empty turn; it must still fall through.
export function deltaHasClientContent(delta) {
  if (!delta || typeof delta !== "object") return false;
  const c = delta.content;
  if (typeof c === "string" && c.length > 0) return true;
  if (Array.isArray(c) && c.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  // OpenAI "Responses" style / non-chat deltas occasionally use output_text
  if (typeof delta.output_text === "string" && delta.output_text.length > 0) return true;
  return false;
}

const nonEmptyString = (s) => typeof s === "string" && s.length > 0;

// "This stream is producing tokens" — content OR reasoning/thinking. Used ONLY to decide when
// the peek may stop buffering and hand the head to the client; it never decides failover, which
// stays on deltaHasClientContent.
//
// Why a separate test: a reasoning model can think for tens of seconds before its first answer
// character. Holding the whole stream until that character turns a healthy turn into a frozen
// screen followed by one dump — the client's first and last token land in the same instant, so
// any decode-rate meter reports a meaningless burst while the user watched nothing happen.
export function deltaHasProgress(delta) {
  if (!delta || typeof delta !== "object") return false;
  if (deltaHasClientContent(delta)) return true;
  if (nonEmptyString(delta.reasoning_content)) return true;
  if (nonEmptyString(delta.reasoning)) return true;
  if (nonEmptyString(delta.thinking)) return true;
  return false;
}

// The peek reads the CLIENT-format stream, which is OpenAI chat (/v1/chat/completions),
// Anthropic Messages (/v1/messages) or OpenAI Responses (/v1/responses). A format the peek
// cannot read never shows content: every combo member would be judged "empty" and called in
// turn, and the LAST one returned. Every format gets the same rule: answer text and tool calls
// are content; reasoning / thinking is progress but not content. Finish reasons are reported in
// the hub (OpenAI) vocabulary so isNoRetryFinish applies to every format.

// Anthropic Messages event.
function inspectClaudeEvent(obj) {
  let content = false, progress = false, finishReason = null;
  if (obj.type === CLAUDE_EVENT.CONTENT_BLOCK_DELTA) {
    const d = obj.delta || {};
    if (d.type === CLAUDE_DELTA.TEXT && nonEmptyString(d.text)) content = true;
    if (d.type === CLAUDE_DELTA.INPUT_JSON && nonEmptyString(d.partial_json)) content = true;
    if (d.type === CLAUDE_DELTA.THINKING && nonEmptyString(d.thinking)) progress = true;
  } else if (obj.type === CLAUDE_EVENT.CONTENT_BLOCK_START) {
    const b = obj.content_block || {};
    if (b.type === CLAUDE_BLOCK.TOOL_USE) content = true;
    if (b.type === CLAUDE_BLOCK.TEXT && nonEmptyString(b.text)) content = true;
    // A thinking block opening with no text yet still proves the turn is alive.
    if (b.type === CLAUDE_BLOCK.THINKING || b.type === CLAUDE_BLOCK.REDACTED_THINKING) progress = true;
  } else if (obj.type === CLAUDE_EVENT.MESSAGE_DELTA && obj.delta?.stop_reason) {
    // refusal → content_filter (the translator renders content_filter as refusal for Claude clients)
    finishReason = toOpenAIFinish(obj.delta.stop_reason, FORMATS.CLAUDE);
  }
  return { content, progress: content || progress, finishReason };
}

// OpenAI Responses event. Tool calls are function_call / custom_tool_call output items or
// their argument deltas. Terminal events: completed → stop; incomplete → content_filter
// (no-retry) or length by incomplete_details.reason; failed → "failed" (retryable).
const RESPONSES_TOOL_ITEMS = new Set([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL]);
const RESPONSES_INCOMPLETE_FINISH = {
  [RESPONSES_INCOMPLETE_REASON.CONTENT_FILTER]: OPENAI_FINISH.CONTENT_FILTER,
  [RESPONSES_INCOMPLETE_REASON.MAX_OUTPUT_TOKENS]: OPENAI_FINISH.LENGTH,
};
function inspectResponsesEvent(obj) {
  let content = false, progress = false, finishReason = null;
  switch (obj.type) {
    case RESPONSES_EVENT.OUTPUT_TEXT_DELTA:
    case RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DELTA:
    case RESPONSES_EVENT.CUSTOM_TOOL_CALL_INPUT_DELTA:
      content = nonEmptyString(obj.delta);
      break;
    case RESPONSES_EVENT.OUTPUT_TEXT_DONE:
      content = nonEmptyString(obj.text);
      break;
    case RESPONSES_EVENT.OUTPUT_ITEM_ADDED:
    case RESPONSES_EVENT.OUTPUT_ITEM_DONE:
      content = RESPONSES_TOOL_ITEMS.has(obj.item?.type);
      break;
    case RESPONSES_EVENT.COMPLETED:
      finishReason = OPENAI_FINISH.STOP;
      break;
    case RESPONSES_EVENT.INCOMPLETE:
      finishReason = RESPONSES_INCOMPLETE_FINISH[obj.response?.incomplete_details?.reason] || RESPONSES_STATUS.INCOMPLETE;
      break;
    case RESPONSES_EVENT.FAILED:
      finishReason = RESPONSES_STATUS.FAILED;
      break;
  }
  // `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` are spelled
  // dynamically by the API and are not enumerated above. Any event carrying a non-empty
  // `delta` string is the model emitting tokens, which is all "alive" needs.
  if (!content && nonEmptyString(obj.delta)) progress = true;
  return { content, progress: content || progress, finishReason };
}

// Inspect one complete client-format SSE line (parsed with the shared parseSSELine) and report
// whether it carries content, progress (content or reasoning) and/or a finish reason. Non-data
// lines and "[DONE]" carry nothing.
export function inspectSSELine(line) {
  const parsed = parseSSELine(line.trimStart());
  if (!parsed || parsed.done) return { content: false, progress: false, finishReason: null };
  if (typeof parsed.type === "string" && !Array.isArray(parsed.choices)) {
    return parsed.type.startsWith(RESPONSES_EVENT_PREFIX) ? inspectResponsesEvent(parsed) : inspectClaudeEvent(parsed);
  }
  let content = false, progress = false, finishReason = null;
  for (const choice of parsed.choices || []) {
    const delta = choice.delta || choice.message || {};
    if (deltaHasClientContent(delta)) content = true;
    if (deltaHasProgress(delta)) progress = true;
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return { content, progress: content || progress, finishReason };
}

// Scan the COMPLETE lines of a decoded SSE buffer and update the running decision.
// The trailing fragment (a line still being received) is not parsed — it is returned in
// `state.pending` for the caller to prepend to the next chunk. `sawContent` and `sawProgress`
// latch true.
export function scanSSEBuffer(text, state = { sawContent: false, sawProgress: false, finishReason: null }) {
  const lines = text.split("\n");
  state.pending = lines.pop();
  for (const line of lines) {
    const info = inspectSSELine(line);
    if (info.content) state.sawContent = true;
    if (info.progress) state.sawProgress = true;
    if (info.finishReason) state.finishReason = info.finishReason;
  }
  return state;
}

// True when a finished, content-less stream should NOT be retried because the emptiness
// is legitimate and would recur on every candidate (safety / recitation / blocklist /
// prohibited-content). Everything else that finished empty is retryable.
export function isNoRetryFinish(finishReason) {
  if (!finishReason) return false;
  return NO_RETRY_EMPTY_FINISH.has(String(finishReason).toLowerCase());
}

// Peek a streaming Response body and decide whether this candidate is worth committing. The peek
// stops buffering at the FIRST sign of life:
//   * content frame               → "content" (the candidate answered; commit)
//   * reasoning / thinking frame  → "live"    (the turn is producing tokens; commit immediately —
//                                              waiting for answer text freezes reasoning models)
//   * stream ended, nothing seen  → "empty"   (the case this feature exists for: 200 + no payload)
//   * deadline elapsed            → "content", fail-open: never hold a possibly-valid slow stream
// Returns the decision, the buffered head bytes, the live reader, and — if the deadline fired
// mid-read — the still-pending read() (`pendingRead`) so the caller can resume from it WITHOUT
// abandoning the chunk it will deliver.
export async function peekStreamForContent(body, { deadlineMs = EMPTY_PEEK_DEADLINE_MS, requestDeadline = null } = {}) {
  requestDeadline?.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const headChunks = [];
  const state = { sawContent: false, sawProgress: false, finishReason: null };
  let textBuf = "";

  // Settled outcome for a peek that stopped without content: reasoning that already flowed means
  // the candidate is alive, not empty. "empty" is reserved for a stream that released nothing.
  const terminalOutcome = (timedOut) => {
    if (state.sawContent) return "content";
    if (state.sawProgress) return "live";
    return timedOut ? "content" : "empty";
  };

  // Clamp: 0 / NaN / negative would otherwise disable the timeout and let a stalled-but-open
  // upstream hang the request forever in the hot path. There is no "disable" via this value.
  const validDeadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : EMPTY_PEEK_DEADLINE_MS;
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("__deadline__"), validDeadline); });
  const settle = (ret) => { if (timer) { clearTimeout(timer); timer = null; } return ret; };

  let pendingRead = null;
  while (true) {
    if (!pendingRead) pendingRead = reader.read();
    let res;
    try {
      res = requestDeadline
        ? await requestDeadline.run(() => Promise.race([pendingRead, deadline]))
        : await Promise.race([pendingRead, deadline]);
    } catch (err) {
      if (isRequestAbortError(err)) {
        clearTimeout(timer);
        try { reader.cancel(err).catch(() => {}); } catch { /* already closed */ }
        try { reader.releaseLock(); } catch { /* pending/non-standard reader */ }
        throw err;
      }
      // Upstream errored mid-peek. Body is locked to this reader; hand it back so the caller
      // can reconstruct (the replay will surface the same error). The failed read is consumed.
      pendingRead = null;
      return settle({ outcome: terminalOutcome(false), timedOut: false, head: headChunks, reader, pendingRead: null, finishReason: state.finishReason, error: err });
    }
    if (res === "__deadline__") {
      // Fail-open: commit whatever we have. Hand the STILL-PENDING read to the caller so its
      // chunk is replayed, not dropped (fixes the content-dropping deadline race).
      return settle({ outcome: terminalOutcome(true), timedOut: true, head: headChunks, reader, pendingRead, finishReason: state.finishReason });
    }
    const { done, value } = res;
    pendingRead = null;
    if (done) {
      if (textBuf) scanSSEBuffer(textBuf + "\n", state); // final line without a trailing newline
      return settle({ outcome: terminalOutcome(false), timedOut: false, head: headChunks, reader, pendingRead: null, finishReason: state.finishReason });
    }
    headChunks.push(value);
    textBuf += decoder.decode(value, { stream: true });
    scanSSEBuffer(textBuf, state);
    textBuf = state.pending; // only the not-yet-complete line carries over
    if (state.sawContent) {
      return settle({ outcome: "content", timedOut: false, head: headChunks, reader, pendingRead: null, finishReason: state.finishReason });
    }
    if (state.sawProgress) {
      // Hand the head over now: the client starts painting while the model keeps thinking.
      return settle({ outcome: "live", timedOut: false, head: headChunks, reader, pendingRead: null, finishReason: state.finishReason });
    }
  }
}

// Rebuild a ReadableStream that replays the buffered head bytes, then the handed-off in-flight
// read (if the peek ended on a deadline), then whatever remains from the reader. Sequential —
// only ever one outstanding reader.read() at a time.
export function reconstructStream(head, reader, pendingRead = null) {
  let pending = pendingRead;
  return new ReadableStream({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        let result;
        if (pending) { result = await pending; pending = null; }
        else { result = await reader.read(); }
        const { done, value } = result;
        if (done) { reader.releaseLock(); controller.close(); return; }
        controller.enqueue(value);
      } catch (error) {
        try { reader.releaseLock(); } catch { /* pending/non-standard reader */ }
        controller.error(error);
      }
    },
    cancel(reason) {
      try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* pending/non-standard reader */ }
    },
  });
}
