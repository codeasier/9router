// Per-model gateway overrides: thinking intensity + protocol (chat/responses/messages).
// Merge: connection providerSpecificData.modelConfigs[model]
//      > settings.modelOverrides["provider/model"]
//      > registry static thinking (protocol still uses existing targetFormat path).

import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { normalizeModelId } from "../providers/models/schema.js";
import {
  getModelSupportedFormats,
  getModelTargetFormat,
  getModelThinking,
  PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { FORMATS } from "../translator/formats.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { getTargetFormat, resolveTransport, resolveTransportForFormat } from "./provider.js";
import { ANTHROPIC_COMPAT_BASE, OPENAI_COMPAT_BASE } from "../providers/shared.js";

export const PROTOCOL_ALIASES = {
  chat: FORMATS.OPENAI,
  responses: FORMATS.OPENAI_RESPONSES,
  messages: FORMATS.CLAUDE,
  [FORMATS.OPENAI]: FORMATS.OPENAI,
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.OPENAI_RESPONSE]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
};

export const PROTOCOL_LABELS = {
  [FORMATS.OPENAI]: "chat",
  [FORMATS.OPENAI_RESPONSES]: "responses",
  [FORMATS.CLAUDE]: "messages",
};

export const BINARY_PROTOCOLS = new Set([
  FORMATS.KIRO,
  FORMATS.CURSOR,
  FORMATS.COMMANDCODE,
]);

const KNOWN_LEVEL_ALIASES = new Set(["max", "ultra", "xhigh", "minimal", "thinking"]);

function firstNonAuto(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "auto") {
      return value.trim();
    }
  }
  return null;
}

export function normalizeProtocol(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key || key === "auto") return null;
  return PROTOCOL_ALIASES[key] || null;
}

export function overrideLookupKeys(provider, model) {
  const clean = stripThinkingSuffix(model);
  const normalized = normalizeModelId(clean);
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  return [...new Set([
    `${provider}/${clean}`,
    `${provider}/${normalized}`,
    `${alias}/${clean}`,
    `${alias}/${normalized}`,
  ])];
}

function pickLayer(map, keys) {
  if (!map || typeof map !== "object") return null;
  for (const key of keys) {
    const value = map[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}

function pickModelConfig(configs, model) {
  if (!configs || typeof configs !== "object") return null;
  const clean = stripThinkingSuffix(model);
  const normalized = normalizeModelId(clean);
  return configs[clean] || configs[normalized] || configs[model] || null;
}

export function resolveModelOverride({ provider, model, credentials, settings } = {}) {
  const keys = overrideLookupKeys(provider, model);
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const connection = pickModelConfig(credentials?.providerSpecificData?.modelConfigs, model);
  const global = pickLayer(settings?.modelOverrides, keys);
  return {
    thinking: firstNonAuto(connection?.thinking, global?.thinking, getModelThinking(alias, model)),
    protocol: normalizeProtocol(connection?.protocol) || normalizeProtocol(global?.protocol),
  };
}

export function thinkingIntentFromOverride(thinking, provider, model) {
  if (typeof thinking !== "string" || !thinking.trim()) return null;
  const raw = thinking.trim().toLowerCase();
  if (raw === "auto") return null;

  const cleanModel = stripThinkingSuffix(model);
  const levels = getThinkingLevels(provider, cleanModel);

  if (raw === "none" || raw === "off") return { mode: "none", force: true };
  if (raw === "thinking") return { mode: "auto", force: true };
  if (/^\d+$/.test(raw)) return { mode: "budget", budget: Number(raw), force: true };

  if (levels && !levels.includes(raw) && !KNOWN_LEVEL_ALIASES.has(raw)) return null;
  return { mode: "level", level: raw, force: true };
}

export function buildForcedTransport(provider, format, credentials) {
  if (!format || BINARY_PROTOCOLS.has(format)) return null;
  const matched = resolveTransportForFormat(provider, format);
  if (matched) return matched;

  if (typeof provider === "string" && provider.startsWith("openai-compatible-")) {
    if (format !== FORMATS.OPENAI && format !== FORMATS.OPENAI_RESPONSES) return null;
    const baseUrl = (credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE).replace(/\/$/, "");
    const path = format === FORMATS.OPENAI_RESPONSES ? "/responses" : "/chat/completions";
    return { format, baseUrl: `${baseUrl}${path}` };
  }
  if (typeof provider === "string" && provider.startsWith("anthropic-compatible-")) {
    if (format !== FORMATS.CLAUDE) return null;
    const baseUrl = (credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE).replace(/\/$/, "");
    return { format, baseUrl: `${baseUrl}/messages` };
  }
  return null;
}

export function protocolOptionsForModel(provider, model, { isOpenAICompatible, isAnthropicCompatible } = {}) {
  if (BINARY_PROTOCOLS.has(PROVIDERS[provider]?.format)) return [];
  if (isAnthropicCompatible) return [FORMATS.CLAUDE];
  if (isOpenAICompatible) return [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES];

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const supported = getModelSupportedFormats(alias, model);
  const fromSupported = (supported || []).filter((format) => PROTOCOL_LABELS[format]);
  if (fromSupported.length) return fromSupported;

  const transports = PROVIDERS[provider]?.transports;
  if (Array.isArray(transports) && transports.length) {
    return [...new Set(transports.map((entry) => entry.format).filter((format) => PROTOCOL_LABELS[format]))];
  }
  return [];
}

export function resolveChatRouting({
  provider,
  model,
  sourceFormat,
  credentials,
  settings,
  log,
} = {}) {
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const override = resolveModelOverride({ provider, model, credentials, settings });
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const thinkingIntent = thinkingIntentFromOverride(override.thinking, provider, model);
  if (override.thinking && !thinkingIntent) {
    log?.warn?.("OVERRIDE", `thinking ${override.thinking} is not valid for ${provider}/${model}; ignoring`);
  }

  let forcedFormat = override.protocol;
  const providerFormat = getTargetFormat(provider, credentials);
  if (forcedFormat) {
    if (BINARY_PROTOCOLS.has(forcedFormat) || BINARY_PROTOCOLS.has(providerFormat)) {
      log?.warn?.("OVERRIDE", `protocol force ignored for binary provider ${provider}`);
      forcedFormat = null;
    } else if (modelSupportedFormats && !modelSupportedFormats.includes(forcedFormat)) {
      log?.warn?.("OVERRIDE", `protocol ${forcedFormat} is not in supportedFormats for ${provider}/${model}; falling back`);
      forcedFormat = null;
    }
  }

  if (forcedFormat) {
    const useTransport = buildForcedTransport(provider, forcedFormat, credentials);
    if (useTransport) {
      return { targetFormat: useTransport.format, useTransport, override, thinkingIntent };
    }
    if (forcedFormat === providerFormat || forcedFormat === modelTargetFormat) {
      return { targetFormat: forcedFormat, useTransport: null, override, thinkingIntent };
    }
    log?.warn?.("OVERRIDE", `no transport for protocol ${forcedFormat} on ${provider}; falling back`);
  }

  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const useTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat))
    ? runtimeTransport
    : null;
  const targetFormat = modelTargetFormat || useTransport?.format || providerFormat;
  return { targetFormat, useTransport, override, thinkingIntent };
}
