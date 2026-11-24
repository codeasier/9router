import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import traeRegistry from "../../open-sse/providers/registry/trae.js";
import traeGlobalRegistry from "../../open-sse/providers/registry/trae-global.js";
import traeEnterpriseRegistry from "../../open-sse/providers/registry/trae-enterprise.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import traeOAuth, { parseTraeCallback, traeAccessTokenFromExchange, traeEnterprise, traeGlobal } from "../../src/lib/oauth/providers/trae.js";
import { traeOAuthCallbackPath } from "../../src/lib/oauth/constants/oauth.js";
import {
  clearTraeCatalogCache,
  collectTraeModels,
  normalizeToolSchema,
  prepareSoloBody,
  resolveTraeModels,
  resolveWireTarget,
} from "../../open-sse/services/traeSolo.js";

function sseResponse(text) {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function catalogOf(channels) {
  return async (url, options) => {
    if (String(url).includes("get_detail_param")) {
      const body = JSON.parse(options.body);
      const rows = channels[body.function] || [];
      return new Response(JSON.stringify({ config_info_list: rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    catalogOf.last = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
    return sseResponse(catalogOf.sse);
  };
}

const OUTPUT = [
  "event: output",
  'data: {"response":"hello","reasoning_content":"think"}',
  "",
  "event: output",
  'data: {"tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}',
  "",
  "event: token_usage",
  'data: {"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}',
  "",
  "event: done",
  'data: {"finish_reason":"stop"}',
  "",
].join("\n");

describe("Trae llm_utils_chat", () => {
  it("pins each provider to its own gateway and OAuth exchange", () => {
    expect(PROVIDERS.trae.baseUrl).toBe("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat");
    expect(PROVIDERS["trae-global"].baseUrl).toBe("https://coresg-normal.trae.ai/api/agent/v3/llm_utils_chat");
    expect(PROVIDERS["trae-enterprise"].baseUrl).toBe("https://console.enterprise.trae.cn/api/agent/v3/llm_utils_chat");
    expect(PROVIDERS.trae.tokenUrl).toBe("https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken");
    expect(PROVIDERS["trae-enterprise"].tokenUrl).toBe(PROVIDERS.trae.tokenUrl);
    expect(PROVIDERS["trae-global"].tokenUrl).toBe("https://api.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken");
    expect(traeOAuth.loginGuidanceUrls[0]).toBe("https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance");
    expect(traeEnterprise.loginGuidanceUrls).toEqual(traeOAuth.loginGuidanceUrls);
    expect(traeGlobal.loginGuidanceUrls[0]).toBe("https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance");
    expect(traeOAuthCallbackPath("trae")).toBe("/authorize");
    expect(traeOAuthCallbackPath("trae-enterprise")).toBe("/authorize");
    expect(traeOAuthCallbackPath("trae-global")).toBe("/callback");
    expect(getExecutor("trae").provider).toBe("trae");
    expect(getExecutor("trae-global").provider).toBe("trae-global");
    expect(getExecutor("trae-enterprise").provider).toBe("trae-enterprise");
    expect(traeRegistry.display.name).toBe("Trae");
    expect(traeGlobalRegistry.display.name).toBe("Trae (Global)");
    expect(traeEnterpriseRegistry.display.name).toBe("Trae (Enterprise)");
    const zh = JSON.parse(readFileSync(new URL("../../public/i18n/literals/zh-CN.json", import.meta.url), "utf8"));
    expect(zh["Trae"]).toBe("Trae");
    expect(zh["Trae (Global)"]).toBe("Trae（国际版）");
    expect(zh["Trae (Enterprise)"]).toBe("Trae（企业版）");
    const registrySource = readFileSync(new URL("../../open-sse/providers/registry/traeShared.js", import.meta.url), "utf8");
    expect(registrySource).toContain("../../services/traeRoutes.js");
    expect(registrySource.includes("traeSolo.js")).toBe(false);
  });

  it("extracts the refresh token from a pasted Trae callback URL", () => {
    const parsed = parseTraeCallback(
      "http://127.0.0.1:32871/authorize?isRedirect=true&refreshToken=rt-1&host=https%3A%2F%2Fapi.trae.cn&userRegion=CN&userJwt=jwt-1"
    );
    expect(parsed.refreshToken).toBe("rt-1");
    expect(parsed.loginHost).toBe("https://api.trae.cn");
    expect(parsed.cloudideToken).toBe("jwt-1");
    expect(parseTraeCallback("refreshToken=rt-2&host=https://api.trae.cn").refreshToken).toBe("rt-2");
    expect(parseTraeCallback("http://127.0.0.1:9/authorize#refreshToken=rt-3").refreshToken).toBe("rt-3");
    expect(parseTraeCallback("http://127.0.0.1:9/callback?userJwt=jwt-only").cloudideToken).toBe("jwt-only");
    expect(() => parseTraeCallback("http://127.0.0.1:9/authorize?isRedirect=true")).toThrow(/refreshToken/);
    expect(traeAccessTokenFromExchange({ Result: "jwt-from-cn" }).accessToken).toBe("jwt-from-cn");
    expect(traeAccessTokenFromExchange({ Result: { AccessToken: "jwt-intl", RefreshToken: "rt-new", ExpiresAt: 123 } })).toEqual({
      accessToken: "jwt-intl",
      refreshToken: "rt-new",
      expiresAt: 123,
    });
  });

  it("keeps session_id off the consumer gateway and on the enterprise gateway", () => {
    const consumer = prepareSoloBody({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }] }, {
      wire: { configName: "glm-5.2", function: "solo_work_remote" },
      enterprise: false,
    });
    const enterprise = prepareSoloBody({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }] }, {
      wire: { configName: "glm-5.2", function: "solo_work_remote" },
      enterprise: true,
    });
    expect(consumer.session_id).toBeUndefined();
    expect(enterprise.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(consumer.function).toBe("solo_work_remote");
    expect(consumer.config_name).toBe("glm-5.2");
    expect(consumer.temperature).toBeUndefined();
    expect(consumer.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("rewrites OpenAI tools into the SOLO envelope", () => {
    const body = prepareSoloBody({
      model: "glm-5.2",
      temperature: 0,
      messages: [
        { role: "developer", content: "be brief" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "bash",
          parameters: { type: "object", properties: { cmd: { type: "string", required: true } } },
        },
      }],
    }, { wire: { configName: "glm-5.2", function: "solo_work_lite" }, enterprise: false });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].tool_calls[0].function).toBeUndefined();
    expect(body.messages[1].tool_calls[0].function_call.name).toBe("bash");
    expect(body.messages[2].tool_call_id).toBe("call_1");
    const parameters = JSON.parse(body.tools[0].function.parameters);
    expect(parameters.properties.cmd.required).toBeUndefined();
    expect(parameters.required).toEqual(["cmd"]);
    expect(normalizeToolSchema({ type: "object", properties: { a: { type: "string", required: true } } }).required).toEqual(["a"]);
  });

  it("lets the first directory channel own a model and skips non-chat rows", () => {
    const byId = new Map();
    collectTraeModels([
      { config_name: "glm-5.3", usage: "chat_completion", display_config: { display_name: "GLM-5.3" } },
      { config_name: "title", usage: "title_generation", display_config: { display_name: "Title" } },
      { config_name: "local-only", usage: "chat_completion", use_remote_service: false, display_config: { display_name: "Local" } },
    ], "solo_work_remote", byId);
    collectTraeModels([
      { config_name: "glm-5.3", usage: "chat_completion", display_config: { display_name: "other" } },
    ], "chat_v3", byId);
    expect([...byId.keys()]).toEqual(["glm-5.3"]);
    expect(byId.get("glm-5.3").function).toBe("solo_work_remote");
    expect(resolveWireTarget([...byId.values()], "GLM-5.3").function).toBe("solo_work_remote");
    expect(resolveWireTarget([...byId.values()], "missing").function).toBe("solo_work_lite");
  });

  it("streams tool calls and resolves the wire model from the directory", async () => {
    clearTraeCatalogCache();
    catalogOf.sse = OUTPUT;
    catalogOf.last = null;
    const fetchImpl = catalogOf({
      solo_work_remote: [{ config_name: "glm-5.3", usage: "chat_completion", display_config: { display_name: "GLM-5.3" } }],
    });
    const executor = getExecutor("trae");
    const original = executor.fetchImpl;
    executor.fetchImpl = fetchImpl;
    try {
      const result = await executor.execute({
        model: "GLM-5.3",
        body: { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }], tools: [] },
        stream: true,
        credentials: { accessToken: "jwt-secret", providerSpecificData: { deviceId: "0", machineId: "machine-1" } },
      });
      expect(result.response.status).toBe(200);
      expect(result.url).toBe("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat");
      expect(result.headers.Authorization).toBe("Cloud-IDE-JWT [redacted]");
      expect(catalogOf.last.url).toBe(result.url);
      expect(catalogOf.last.body.model).toBe("glm-5.3");
      expect(catalogOf.last.body.config_name).toBe("glm-5.3");
      expect(catalogOf.last.body.function).toBe("solo_work_remote");
      expect(catalogOf.last.body.session_id).toBeUndefined();
      expect(catalogOf.last.headers.Authorization).toBe("Cloud-IDE-JWT jwt-secret");
      const text = await result.response.text();
      expect(text).toContain('"content":"hello"');
      expect(text).toContain('"reasoning_content":"think"');
      expect(text).toContain('"name":"bash"');
      expect(text).toContain('"finish_reason":"tool_calls"');
      expect(text).toContain("data: [DONE]");
    } finally {
      executor.fetchImpl = original;
      clearTraeCatalogCache();
    }
  });

  it("returns quota exhaustion before opening a success stream", async () => {
    clearTraeCatalogCache();
    const fetchImpl = async (url) => {
      if (String(url).includes("get_detail_param")) {
        return new Response(JSON.stringify({ config_info_list: [] }), { status: 200 });
      }
      return sseResponse('event: error\ndata: {"code":4008,"message":"quota"}\n\n');
    };
    const executor = getExecutor("trae-global");
    const original = executor.fetchImpl;
    executor.fetchImpl = fetchImpl;
    try {
      const result = await executor.execute({
        model: "gpt-5.4",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: { accessToken: "jwt" },
      });
      expect(result.response.status).toBe(402);
      expect(result.url).toBe("https://coresg-normal.trae.ai/api/agent/v3/llm_utils_chat");
      const body = await result.response.json();
      expect(body.error.message).toMatch(/quota/i);
    } finally {
      executor.fetchImpl = original;
    }
  });

  it("adds a session id only for the enterprise provider", async () => {
    clearTraeCatalogCache();
    let sent;
    const fetchImpl = async (url, options) => {
      if (String(url).includes("get_detail_param")) {
        return new Response(JSON.stringify({ config_info_list: [] }), { status: 200 });
      }
      sent = { url: String(url), body: JSON.parse(options.body) };
      return sseResponse('event: output\ndata: {"response":"ok"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n');
    };
    const executor = getExecutor("trae-enterprise");
    const original = executor.fetchImpl;
    executor.fetchImpl = fetchImpl;
    try {
      const result = await executor.execute({
        model: "glm-5.2",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { accessToken: "jwt" },
      });
      expect(sent.url).toBe("https://console.enterprise.trae.cn/api/agent/v3/llm_utils_chat");
      expect(sent.body.session_id).toMatch(/^[0-9a-f-]{36}$/);
      const completion = await result.response.json();
      expect(completion.choices[0].message.content).toBe("ok");
      expect(completion.choices[0].finish_reason).toBe("stop");
    } finally {
      executor.fetchImpl = original;
      clearTraeCatalogCache();
    }
  });

  it("reads the account directory for the picker and skips non-chat rows", async () => {
    clearTraeCatalogCache();
    const calls = [];
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), function: body.function });
      return Response.json({
        config_info_list: [
          { config_name: "live-model", display_config: { display_name: "Live Model" }, usage: "chat_completion" },
          { config_name: "local-only", use_remote_service: false, usage: "chat_completion" },
          { config_name: "embed", usage: "embedding" },
        ],
      });
    };
    const globalModels = await resolveTraeModels(
      { provider: "trae-global", accessToken: "jwt" },
      { fetchImpl, forceRefresh: true },
    );
    expect(globalModels).toEqual([{ id: "live-model", name: "Live Model" }]);
    expect(calls.map((call) => call.function)).toEqual([
      "solo_work_remote",
      "solo_work_lite",
      "solo_agent_remote",
      "chat_v3",
    ]);
    expect(calls[0].url).toBe("https://coresg-normal.trae.ai/api/ide/v1/get_detail_param");

    calls.length = 0;
    await resolveTraeModels(
      { provider: "trae-enterprise", accessToken: "jwt-ent" },
      { fetchImpl, forceRefresh: true },
    );
    expect(calls.map((call) => call.function)).toContain("solo_coder");
    expect(calls[0].url).toBe("https://console.enterprise.trae.cn/api/ide/v1/get_detail_param");
  });

  it("maps a pasted JWT onto the provider that was connected", async () => {
    const cn = traeOAuth.mapTokens(await traeOAuth.exchangeToken(traeOAuth.config, "Cloud-IDE-JWT jwt-cn"), { userInfo: {} });
    const global = traeGlobal.mapTokens(await traeGlobal.exchangeToken(traeGlobal.config, "jwt-sg"), { userInfo: { aiRegion: "US" } });
    const enterprise = traeEnterprise.mapTokens(await traeEnterprise.exchangeToken(traeEnterprise.config, "jwt-ent"), { userInfo: {} });
    expect(cn.accessToken).toBe("jwt-cn");
    expect(cn.providerSpecificData.chatRoute).toBe("consumer");
    expect(cn.providerSpecificData.userRegion).toBe("CN");
    expect(cn.providerSpecificData.deviceId).toBe("0");
    expect(global.providerSpecificData.userRegion).toBe("SG");
    expect(global.providerSpecificData.aiRegion).toBe("US");
    expect(enterprise.providerSpecificData.chatRoute).toBe("enterprise");
    expect(enterprise.providerSpecificData.userRegion).toBe("CN");
  });
});
