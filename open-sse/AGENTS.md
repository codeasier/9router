# open-sse

Inherits [repository guidance](../AGENTS.md). Provider-agnostic execution and translation engine for chat and media modalities. The app-side `src/sse/` layer owns request authentication, stored connection selection and persistence integration; this layer receives resolved model information and credentials.

## Request lifecycle (chat)

1. `handlers/chatCore.js` receives `modelInfo` (provider/model) from its caller, detects the client format and resolves transport/thinking overrides. Model-string parsing belongs to the caller/model services, not a new parse inside this core.
2. **Cursor RTK runs before translation**, because its translator rewrites source tool results into user text. Capability stripping and remote-image prefetch apply to non-native-passthrough requests.
3. `translator/index.js` translates client format to provider format, or the native-client path bypasses conversion with provider-specific normalization.
4. Apply final-body token savers: RTK when not already applied, Headroom compression, Caveman/Ponytail prompt injection and optional PXPIPE. Preserve ordering; Claude native cache anchors are applied after body-changing savers.
5. `executors/index.js` chooses an executor; `execute()` performs the upstream call. Retry/credential refresh and streaming/non-streaming response handlers convert the result to the client format.

## Directory map

- `config/` — shared constants, runtime limits and provider/model compatibility views. `providers.js` and `providerModels.js` expose data built from `providers/registry/`.
- `translator/` — format conversion. `request/<from>-to-<to>.js`, `response/<from>-to-<to>.js`, `schema/` (enums: ROLE, CLAUDE_BLOCK…), `concerns/` (shared logic), `formats.js`+`formats/` (per-format). `index.js` is the registry/entry.
- `executors/` — per-provider upstream call. `base.js` (BaseExecutor), one file per special provider, `index.js` map.
- `providers/` — canonical `registry/{id}.js` definitions, model normalization, capabilities and pricing. `index.js` builds transport/model/OAuth/media views from the static registry list.
- `handlers/` — per-modality cores (chat/image/embedding/tts/stt/search) + sub-provider folders. `chatCore/` has the streaming/non-streaming/sse-to-json handlers.
- `rtk/` — request token-killer. `index.js` compresses `tool_result` content in-place (OpenAI/Claude/Kiro shapes); `filters/` per-tool compressors + `autodetect.js`; `headroom.js` external compress proxy; `caveman.js` system-prompt injector.
- `transformer/` — `responsesTransformer.js` (Chat Completions SSE → Codex Responses API SSE), `streamToJsonConverter.js`.
- `shared/` — cross-provider auth/identity: `clineAuth.js`, `machineId.js`, `qoder/`.
- `services/` — `model.js`, `provider.js`, `accountFallback.js`, `combo.js`, `compact.js`, `tokenRefresh/`+`tokenRefresh.js`, `oauthCredentialManager.js`, `usage/`, `projectId.js`, `kiroModels.js`/`qoderModels.js`.
- `utils/` — streamHandler, stream, sse, error, sessionManager, claudeCloaking, clientDetector, proxyFetch (patches global fetch), cursorProtobuf/cursorChecksum, ollamaTransform.

## Conventions

- Config-driven, DRY, camelCase. NEVER hardcode values, models, or block/role strings — use `config/` + `schema/` constants.
- Translator fallback pivots through OpenAI. Exact registered request `source:target` and response `target:source` pairs run as **direct routes**, avoiding the double-hop for pairs such as Claude/Kiro.
- Translators self-register via `register(from, to, reqFn, resFn)` as an import side-effect. New files MUST be statically imported in `translator/index.js`; `initTranslators()` is a compatibility no-op, not the registration loader.

## How to add

- **Provider/model**: use `providers/REGISTRY_TEMPLATE.js` and a current registry entry as references for `providers/registry/{id}.js`. Put transport, models and display metadata there; `config/providerModels.js` re-exports the derived model table and owns lookup helpers, not another model list. New entries must be included in the static registry import/export list before runtime or matrix tests can see them. Generic OpenAI-compatible providers need no dedicated executor.
- **Executor** (only for non-standard upstream): subclass `BaseExecutor` (override `getBaseUrls`/`buildHeaders`/`buildUrl`/`execute`), register in `executors/index.js` map. `getExecutor` falls back to `DefaultExecutor` when absent.
- **Translator**: add `request|response/<from>-to-<to>.js` calling `register(...)`, then import it in `translator/index.js`. Keep the test helper `../tests/translator/registerAll.js` aligned if extending that explicit import list. Reuse `schema/` + `concerns/` — don't re-implement parsing.

## Pitfalls

- OpenAI bridge is lossy (thinking, non-base64 images, tool ids, is_error) — prefer a direct route for fragile pairs.
- `providers/registry/index.js` is labeled auto-generated but is checked-in static registration, not runtime directory discovery. No index generator is established by the current `scripts/` implementations: `migrate-registry.mjs` points at its own script directory and rewrites schema entries, while `injectDisplayToRegistry.mjs` injects metadata into provider files. Neither generates the index; do not run them as an index-refresh or validation command. Establish the generation mechanism before regenerating that file. The template lives outside the imported registry.
- Special binary/protobuf formats (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — handle in their executor.
- RTK and Headroom are **fail-open**: disabled/error paths return null rather than aborting the chat request. RTK mutates content as it iterates, so an error is not a guarantee of whole-body rollback. Preserve original text for a failed filter and skip Claude `is_error:true` / Kiro `status:"error"` results to retain traces.

## Focused verification

Use [test setup](../tests/AGENTS.md), then run from `tests/`:

```bash
npx vitest run translator/coverage-all-models.test.js translator/format-roundtrip.test.js
npx vitest run unit/capabilities.test.js unit/model-overrides.test.js unit/model-overrides-chatcore.test.js
npx vitest run unit/rtk-cursor-pretranslate.test.js
```

Select the files relevant to the change. Protocol work also needs executor/stream tests; a translator-only catalog smoke does not validate upstream auth, wire envelopes or account fallback. See [translator test guidance](../tests/translator/AGENTS.md) for direct routes, expected-failure cases and live-provider gates. Provider/alias/OAuth changes also have snapshot checks described in the parent tests guide.
