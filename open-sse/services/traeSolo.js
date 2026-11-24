import crypto from "crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { TRAE_CHAT_PATH, TRAE_ROUTES } from "./traeRoutes.js";

export { TRAE_CHAT_PATH, TRAE_ROUTES };

// Trae IDE chat (llm_utils_chat), shared by the CN, international and enterprise
// providers. The gateway is chosen by the provider id. OAuth supplies the
// Cloud-IDE-JWT; nothing here reads a local Trae install.
//
// Protocol notes follow the publicly documented SOLO chat envelope
// (https://github.com/dingminhua/dsh-connect-trae, MIT). This file is an
// independent implementation of that request and SSE shape.
//
// Gateway constants live in traeRoutes.js. This module imports proxyFetch,
// so the dashboard registry must not import it.

export const TRAE_SOLO_FUNCTION = "solo_work_lite";
export const TRAE_MODELS_PATH = "/api/ide/v1/get_detail_param";
export const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
export const TRAE_APP_VERSION = "3.5.54";
// llm_utils_chat binds version codes as integers. A dotted build string is rejected.
export const TRAE_VERSION_CODE = "20260716";
export const TRAE_CATALOG_TTL_MS = 10 * 60 * 1000;

export const TRAE_CHANNELS = {
  cn: ["solo_work_remote", "solo_work_lite", "solo_agent_remote", "chat_v3", "solo_coder"],
  ai: ["solo_work_remote", "solo_work_lite", "solo_agent_remote", "chat_v3"],
};

const MODEL_USAGES = new Set(["chat_completion", "custom_model"]);
const HARD_FINISH_REASONS = new Set(["length", "content_filter", "network_error"]);
const CATALOG_CACHE = new Map();

export function traeRoute(provider) {
  const route = TRAE_ROUTES[provider];
  if (!route) throw new Error(`Unknown Trae provider: ${provider}`);
  return route;
}

export function clearTraeCatalogCache() {
  CATALOG_CACHE.clear();
}

export function buildTraeChatHeaders(credentials) {
  const token = credentials?.accessToken || credentials?.apiKey || "";
  const psd = credentials?.providerSpecificData || {};
  const appVersion = psd.appVersion || TRAE_APP_VERSION;
  const versionCode = /^\d+$/.test(String(psd.versionCode || "")) ? String(psd.versionCode) : TRAE_VERSION_CODE;
  const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
  const headers = {
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Ide-Token": token,
    "X-Cloudide-Token": token,
    "x-plugin-channel": "icube-ai",
    "User-Agent": `Trae/${appVersion}`,
    "x-app-id": TRAE_APP_ID,
    "x-machine-id": String(psd.machineId || "9router"),
    "x-device-id": String(psd.deviceId || "0"),
    "x-device-type": platform,
    "x-os-version": platform,
    "x-app-version": appVersion,
    "x-ide-version": appVersion,
    "x-app-version-code": versionCode,
    "x-ide-version-code": versionCode,
    "x-ide-version-type": "stable",
    "request-traffic-type": "prod",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (psd.userId) headers["x-uid"] = String(psd.userId);
  return headers;
}

export function redactTraeHeaders(headers) {
  const out = { ...headers };
  for (const key of ["Authorization", "X-Ide-Token", "X-Cloudide-Token"]) {
    if (out[key]) out[key] = "Cloud-IDE-JWT [redacted]";
  }
  return out;
}

// Draft-3 `required: true` on a property makes DeepSeek-backed Trae models
// reject the whole tool list. Lift those flags into the parent required array.
export function normalizeToolSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const copy = { ...schema };
  const required = new Set(Array.isArray(copy.required) ? copy.required.filter((item) => typeof item === "string") : []);
  if (copy.properties && typeof copy.properties === "object" && !Array.isArray(copy.properties)) {
    const properties = {};
    for (const [key, value] of Object.entries(copy.properties)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        properties[key] = value;
        continue;
      }
      const flagRequired = value.required === true;
      const prop = normalizeToolSchema(value);
      if (flagRequired) required.add(key);
      if (typeof prop.required === "boolean") {
        const { required: _flag, ...rest } = prop;
        properties[key] = rest;
      } else {
        properties[key] = prop;
      }
    }
    copy.properties = properties;
  }
  for (const key of ["items", "additionalProperties", "not"]) {
    if (copy[key] && typeof copy[key] === "object") copy[key] = normalizeToolSchema(copy[key]);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(copy[key])) copy[key] = copy[key].map((item) => normalizeToolSchema(item));
  }
  if (typeof copy.required === "boolean") delete copy.required;
  if (required.size > 0) copy.required = [...required];
  return copy;
}

function cloneMessage(message) {
  if (!message || typeof message !== "object") return message;
  const copy = { ...message };
  if (copy.role === "developer") copy.role = "system";
  if (typeof copy.content === "string") {
    copy.content = [{ type: "text", text: copy.content }];
  } else if (Array.isArray(copy.content)) {
    copy.content = copy.content.map((part) => {
      if (typeof part === "string") return { type: "text", text: part };
      if (part && typeof part === "object") return { ...part };
      return { type: "text", text: String(part ?? "") };
    });
  }
  if (copy.role === "assistant" && Array.isArray(copy.tool_calls)) {
    copy.tool_calls = copy.tool_calls.map((call) => {
      if (!call || typeof call !== "object") return call;
      const next = { ...call };
      if (next.function && typeof next.function === "object" && !next.function_call) {
        next.function_call = next.function;
        delete next.function;
      }
      return next;
    });
  }
  if (copy.role === "tool" && (typeof copy.tool_call_id !== "string" || copy.tool_call_id === "")) {
    throw new Error("Trae tool message requires tool_call_id");
  }
  return copy;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  const next = { ...tool };
  if (!next.function || typeof next.function !== "object") return next;
  const fn = { ...next.function };
  if (fn.parameters && typeof fn.parameters === "object") {
    fn.parameters = JSON.stringify(normalizeToolSchema(fn.parameters));
  }
  next.function = fn;
  return next;
}

export function prepareSoloBody(input, { wire, enterprise } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const requested = typeof source.model === "string" ? source.model.trim() : "";
  const model = wire?.configName || requested || "glm-5.2";
  const fn = wire?.function || TRAE_SOLO_FUNCTION;
  const body = {
    messages: Array.isArray(source.messages) ? source.messages.map(cloneMessage) : [],
    model,
    config_name: model,
    function: fn,
    stream: true,
  };
  if (Array.isArray(source.tools) && source.tools.length > 0) body.tools = source.tools.map(normalizeTool);
  if (typeof source.reasoning_effort === "string" && source.reasoning_effort && source.reasoning_effort !== "auto" && source.reasoning_effort !== "none") {
    body.reasoning_effort = source.reasoning_effort;
  }
  // The consumer gateway rejects session_id. Only the enterprise host requires it.
  if (enterprise) body.session_id = crypto.randomUUID();
  return body;
}

export function collectTraeModels(list, directoryFunction, byId) {
  for (const raw of list || []) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.use_remote_service === false) continue;
    const usage = typeof raw.usage === "string" ? raw.usage : "";
    if (usage && !MODEL_USAGES.has(usage)) continue;
    const id = typeof raw.config_name === "string" ? raw.config_name : "";
    if (!id || byId.has(id)) continue;
    const display = raw.display_config && typeof raw.display_config === "object" ? raw.display_config : {};
    const name = typeof display.display_name === "string" && display.display_name && display.display_name !== "-"
      ? display.display_name
      : id;
    byId.set(id, { id, name, function: directoryFunction });
  }
  return byId;
}

export function resolveWireTarget(models, requested) {
  const raw = String(requested || "").trim();
  const key = raw.toLowerCase();
  const list = models || [];
  const hit = list.find((model) => model.id.toLowerCase() === key)
    || list.find((model) => String(model.name || "").toLowerCase() === key);
  if (!hit) return { configName: raw || "glm-5.2", function: TRAE_SOLO_FUNCTION };
  return { configName: hit.id, function: hit.function || TRAE_SOLO_FUNCTION };
}

function catalogCacheKey(route, headers) {
  const digest = crypto.createHash("sha256").update(String(headers?.Authorization || "")).digest("hex").slice(0, 16);
  return `${route.id}:${digest}`;
}

export async function loadTraeCatalog({ fetchImpl, headers, route, signal, forceRefresh = false }) {
  const key = catalogCacheKey(route, headers);
  if (!forceRefresh) {
    const cached = CATALOG_CACHE.get(key);
    if (cached && cached.expires > Date.now()) return cached.models;
  }
  const byId = new Map();
  const jsonHeaders = { ...headers, Accept: "application/json" };
  const channels = TRAE_CHANNELS[route.region] || TRAE_CHANNELS.cn;
  for (const directoryFunction of channels) {
    try {
      const response = await fetchImpl(`${route.chatBase}${TRAE_MODELS_PATH}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          function: directoryFunction,
          config_names: null,
          need_prompt: false,
          current_config_info: null,
          poly_prompt: true,
          mode_type: null,
          agent_type: null,
        }),
        signal,
      });
      if (!response?.ok) continue;
      const document = await response.json();
      const list = Array.isArray(document?.config_info_list) ? document.config_info_list : [];
      collectTraeModels(list, directoryFunction, byId);
    } catch {
      // One channel failing must not hide the others, and a catalog miss must not fail the chat.
    }
  }
  const models = [...byId.values()];
  if (models.length > 0) CATALOG_CACHE.set(key, { expires: Date.now() + TRAE_CATALOG_TTL_MS, models });
  return models;
}

// Account directory for the picker and `/v1/models`. Chat keeps the cached
// catalog; a picker passes forceRefresh so the rows match the account now.
export async function resolveTraeModels(credentials, { fetchImpl, signal, forceRefresh = false, proxyOptions = null } = {}) {
  const route = TRAE_ROUTES[credentials?.provider];
  if (!route || (!credentials?.accessToken && !credentials?.apiKey)) return [];
  const impl = fetchImpl || ((url, options) => proxyAwareFetch(url, options, proxyOptions));
  try {
    const models = await loadTraeCatalog({
      fetchImpl: impl,
      headers: buildTraeChatHeaders(credentials),
      route,
      signal,
      forceRefresh,
    });
    return models.map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}

export class SseDecoder {
  constructor() {
    this.buffer = "";
    this.event = undefined;
    this.data = [];
  }

  push(chunk) {
    this.buffer += chunk;
    const events = [];
    while (true) {
      const match = /\r?\n/.exec(this.buffer);
      if (!match) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const emitted = this.consumeLine(line);
      if (emitted) events.push(emitted);
    }
    return events;
  }

  finish() {
    const events = [];
    if (this.buffer) {
      const emitted = this.consumeLine(this.buffer);
      this.buffer = "";
      if (emitted) events.push(emitted);
    }
    const finalEvent = this.dispatch();
    if (finalEvent) events.push(finalEvent);
    return events;
  }

  consumeLine(line) {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }

  dispatch() {
    if (this.data.length === 0) {
      this.event = undefined;
      return undefined;
    }
    const result = { data: this.data.join("\n") };
    if (this.event) result.event = this.event;
    this.event = undefined;
    this.data = [];
    return result;
  }
}

function normalizeUsage(record) {
  const usage = {};
  if (typeof record.prompt_tokens === "number") usage.prompt_tokens = record.prompt_tokens;
  if (typeof record.completion_tokens === "number") usage.completion_tokens = record.completion_tokens;
  if (typeof record.total_tokens === "number") usage.total_tokens = record.total_tokens;
  if (typeof record.reasoning_tokens === "number") {
    usage.completion_tokens_details = { reasoning_tokens: record.reasoning_tokens };
  }
  const cached = typeof record.cache_read_input_tokens === "number"
    ? record.cache_read_input_tokens
    : record.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.prompt_tokens_details = { cached_tokens: cached };
  return usage;
}

export function decodeTraeEvent(event) {
  if (event.data === "[DONE]") return { type: "done", finishReason: "stop" };
  let payload;
  try { payload = JSON.parse(event.data); } catch { return { type: "ignore" }; }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const code = typeof record.code === "number" ? record.code : undefined;
  const errorEvent = event.event === "error"
    || (code !== undefined && code >= 1000 && record.response === undefined && record.tool_calls === undefined
      && event.event !== "token_usage" && event.event !== "done" && event.event !== "output");
  if (errorEvent) {
    return {
      type: "error",
      code,
      message: typeof record.message === "string" ? record.message : "",
    };
  }
  if (event.event === "token_usage") return { type: "usage", usage: normalizeUsage(record) };
  if (event.event === "done" || (typeof record.finish_reason === "string" && record.response === undefined && record.tool_calls === undefined)) {
    return { type: "done", finishReason: typeof record.finish_reason === "string" ? record.finish_reason : "stop" };
  }
  if (event.event === "output" || record.response !== undefined || record.reasoning_content !== undefined || record.tool_calls !== undefined) {
    return {
      type: "delta",
      text: typeof record.response === "string" ? record.response : "",
      reasoning: typeof record.reasoning_content === "string" ? record.reasoning_content : "",
      toolCalls: normalizeToolCalls(record.tool_calls),
    };
  }
  return { type: "ignore" };
}

function normalizeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  const calls = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const rawFunction = raw.function_call && typeof raw.function_call === "object"
      ? raw.function_call
      : raw.function && typeof raw.function === "object"
        ? raw.function
        : {};
    calls.push({
      index: typeof raw.index === "number" ? raw.index : calls.length,
      id: typeof raw.id === "string" ? raw.id : undefined,
      name: typeof rawFunction.name === "string" ? rawFunction.name : undefined,
      arguments: typeof rawFunction.arguments === "string" ? rawFunction.arguments : undefined,
    });
  }
  return calls;
}

const TRAE_ERROR_HINTS = {
  3004: "Trae throttled the shared request queue for this account",
  4017: "Trae temporarily restricted this account",
  1005: "Trae requires a higher plan for this model",
  2001: "Trae has not published a function config for this route",
  4001: "Trae does not serve this model on the SOLO function used for the request",
  4008: "Trae reports this account's quota is exhausted",
  4011: "Trae throttled the SOLO channel for this account",
  4023: "Trae does not recognise this model name",
  4027: "Trae rejected the tool schema",
  4222: "The Trae enterprise tenant allowance is exhausted",
};

export function classifyTraeFailure(failure) {
  const code = failure?.code;
  const hint = TRAE_ERROR_HINTS[code];
  const upstream = failure?.message ? String(failure.message).slice(0, 300) : "";
  const message = hint ? (upstream ? `${hint} (${upstream})` : hint) : (upstream || "Trae request failed");
  let status = 502;
  if (code === 4008 || code === 4222) status = 402;
  else if (code === 4011 || code === 4017 || code === 3004) status = 429;
  else if (code === 1005 || code === 4001 || code === 4023 || code === 4027) status = 400;
  else if (code === 2001) status = 503;
  return { status, message, code };
}

export function toolCallDefect(drafts) {
  for (const draft of drafts.values()) {
    if (!draft.name) return "missing-name";
    try { JSON.parse(draft.arguments || ""); } catch { return "invalid-arguments"; }
  }
  return null;
}

export function decideFinishReason(upstreamReason, drafts) {
  const reason = upstreamReason || "";
  if (HARD_FINISH_REASONS.has(reason)) return reason;
  if (drafts.size > 0 && toolCallDefect(drafts)) return "length";
  if (drafts.size > 0) return "tool_calls";
  return reason || "stop";
}

function replayStream(chunks, reader) {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          controller.enqueue(next.value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

// Read until the first answer, terminal event, or upstream error so a refusal
// can be returned as a real HTTP status before the client stream starts.
export async function separateLeadingTraeFailure(response) {
  if (!response?.body) return { failure: { message: "Trae returned an empty body" } };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  const chunks = [];
  for (let i = 0; i < 64; i++) {
    const next = await reader.read();
    if (next.done) return { stream: replayStream(chunks, reader) };
    chunks.push(next.value.slice());
    for (const event of sse.push(decoder.decode(next.value, { stream: true }))) {
      const decoded = decodeTraeEvent(event);
      if (decoded.type === "error") {
        await reader.cancel().catch(() => {});
        return { failure: decoded };
      }
      if (decoded.type === "delta" || decoded.type === "done") {
        return { stream: replayStream(chunks, reader) };
      }
    }
  }
  return { stream: replayStream(chunks, reader) };
}

export function bridgeTraeStream(source, model) {
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = source.getReader();
      const decoder = new TextDecoder();
      const sse = new SseDecoder();
      const drafts = new Map();
      let usage;
      let finished = false;
      let errored = false;
      const send = (delta, finishReason = null, withUsage = false) => {
        const payload = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        if (withUsage && usage) payload.usage = usage;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const fail = (failure) => {
        const classified = classifyTraeFailure(failure);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          error: { message: classified.message, type: "api_error", code: classified.code ?? "" },
        })}\n\n`));
        errored = true;
        finished = true;
      };
      const consume = (event) => {
        const decoded = decodeTraeEvent(event);
        if (decoded.type === "error") {
          fail(decoded);
          return;
        }
        if (decoded.type === "usage") {
          usage = decoded.usage;
          return;
        }
        if (decoded.type === "delta") {
          const delta = {};
          if (decoded.text) delta.content = decoded.text;
          if (decoded.reasoning) delta.reasoning_content = decoded.reasoning;
          if (decoded.toolCalls.length > 0) {
            const emitted = [];
            for (const call of decoded.toolCalls) {
              const draft = drafts.get(call.index) || { name: "", arguments: "", id: call.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}` };
              if (call.id) draft.id = call.id;
              if (call.name) draft.name = call.name;
              if (call.arguments !== undefined) draft.arguments += call.arguments;
              drafts.set(call.index, draft);
              const fn = {};
              if (call.name) fn.name = call.name;
              if (call.arguments !== undefined) fn.arguments = call.arguments;
              emitted.push({ index: call.index, id: draft.id, type: "function", function: fn });
            }
            delta.tool_calls = emitted;
          }
          if (Object.keys(delta).length > 0) send(delta);
          return;
        }
        if (decoded.type === "done" && !finished) {
          finished = true;
          send({}, decideFinishReason(decoded.finishReason, drafts), true);
        }
      };
      try {
        send({ role: "assistant" });
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event);
          if (finished) break;
        }
        if (!finished) {
          for (const event of sse.finish()) consume(event);
        }
        if (!errored && !finished) {
          finished = true;
          send({}, decideFinishReason(undefined, drafts), true);
        }
        if (errored) await reader.cancel().catch(() => {});
        if (!errored) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        try { reader.releaseLock(); } catch { /* cancel() already released the lock */ }
      }
    },
    cancel(reason) { return source.cancel(reason); },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function aggregateChatCompletion(sseText, model) {
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  const drafts = new Map();
  let finishReason = "stop";
  let usage;
  let error;
  for (const line of String(sseText || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    if (parsed.error) {
      error = parsed.error;
      continue;
    }
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call.index === "number" ? call.index : drafts.size;
        const draft = drafts.get(index) || { id: call.id || `call_${index}`, name: "", arguments: "" };
        if (call.id) draft.id = call.id;
        if (call.function?.name) draft.name = call.function.name;
        if (typeof call.function?.arguments === "string") draft.arguments += call.function.arguments;
        drafts.set(index, draft);
      }
    }
  }
  if (error && !content && drafts.size === 0) return { error };
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (drafts.size > 0) {
    message.tool_calls = [...drafts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, draft]) => ({
        id: draft.id,
        type: "function",
        function: { name: draft.name, arguments: draft.arguments },
      }));
  }
  const completion = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) completion.usage = usage;
  return { completion };
}
