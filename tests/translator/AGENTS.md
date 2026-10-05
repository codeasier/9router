# Translation Layer Tests

Inherits [test-package guidance](../AGENTS.md). This suite covers `open-sse/translator/`: catalog-driven structural checks, format-preservation regressions and opt-in provider integration tests. See [engine guidance](../../open-sse/AGENTS.md) for production registration and ownership.

## 1. Translation layer structure (`open-sse/translator/`)

The fallback pipeline uses **OpenAI as the intermediate format**:
- Request: `source → openai → target` (`translateRequest`), unless an exact `source:target` translator is registered.
- Response: `target → openai → source` (`translateResponse`), unless an exact `target:source` translator is registered.
- Equal formats skip format conversion, but request normalization/thinking/tool handling and response tool-name restoration can still run. Native passthrough in `handleChatCore` is a separate path.

Components:
- `index.js` — `translateRequest` / `translateResponse` / `register(from, to, requestFn, responseFn)` / registry.
- `formats.js` — `FORMATS` enum (openai, claude, gemini, gemini-cli, openai-responses, antigravity, kiro, cursor, commandcode, ollama, vertex).
- `request/<from>-to-<to>.js` — one-way request translation.
- `response/<from>-to-<to>.js` — one-way SSE response translation.
- `schema/` — pure data enums (no logic): `roles.js` (ROLE, GEMINI_ROLE), `blocks.js` (OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM, valid-type lists), `finishReasons.js` (OPENAI_FINISH, CLAUDE_STOP, GEMINI_FINISH), `defaults.js` (MODEL_FALLBACK, DEFAULT_IMAGE_MIME). Import via `schema/index.js`.
- `concerns/` — cross-format translation LOGIC: `chunk.js`, `usage.js`, `reasoning.js`, `thinking.js` (effort↔budget/level), `toolCall.js`, `finishReason.js` (mapping fns), `image.js`, `json.js`.
- `formats/` — per-format logic: `openai.js` (filterToOpenAIFormat), `claude.js`, `gemini.js`, `responsesApi.js`, `maxTokens.js`.

**OpenAI-bridge preservation risks**: cover `thinking`/`reasoning`, non-base64 image URLs, `input_audio`, `is_error`, parallel tool `id`/`index`, non-text system blocks and `tool_choice:"none"`. A passing case on one route does not establish preservation on other direct/bridge paths.

## 2. Test layout

| File | Role |
|---|---|
| `matrix.js` | Reads `PROVIDER_MODELS` → builds matrix (alias, model, targetFormat, strip, upstreamId). DRY core. |
| `registerAll.js` | Explicit translator side-effect imports used by existing tests; historical loader workaround (see §5). |
| `coverage-all-models.test.js` | Tier 1: catalog/provider-group structural translation and configured image-strip checks. |
| `format-roundtrip.test.js` | Tier 2: tool id/system/parallel survive the bridge. |
| `bugs-openai-bridge.test.js` | Exposes concrete bugs (with source file:line). |

## 3. Running

Use the installed test runner from `tests/`; its local config supplies the aliases. For root-run invocations, explicitly pass `--config tests/vitest.config.js` and prefix test filters with `tests/`. There is no `app/` directory to enter in this checkout.

```bash
# From tests/: focused structural/preservation checks
npx vitest run translator/coverage-all-models.test.js translator/format-roundtrip.test.js
npx vitest run translator/bugs-openai-bridge.test.js

# From tests/: opt-in live provider smoke, using local DB credentials
RUN_REAL=1 npx vitest run translator/real/smoke-providers.real.test.js
```
The structural tests above do not dispatch upstream requests. Inspect mocks and entry points before extending that assumption to an entire test directory.

Most `real/` tests use `RUN_REAL=1`, but `nvidia-thinking.e2e.test.js` instead uses `RUN_E2E=1`, `NV_E2E_PORT` (default `20127`) and an existing gateway. Antigravity model tests use `AG_URL` (default `http://localhost:20128/v1`) and `AG_KEY`. DB-discovery tests honor `DATA_DIR` or use `~/.9router/db/data.sqlite`; several require `better-sqlite3` directly rather than the production fallback chain. They do not all share one credential source or portability contract.

Live core-path tests can refresh tokens and record usage as well as consume quota. The smoke test treats 401/402/403/429 as credential/quota issues; this is not universal error handling for every real test. Check which providers/cases actually ran, since skipped or vacuous cases are not protocol coverage.

## 4. Catalog-driven provider coverage

Add provider transport/models in `open-sse/providers/registry/{id}.js` and include the entry in static registry registration. `providers/index.js` builds the model/transport views that the compatibility config files expose. `matrix.js` reads those views and resolves model target format, strip and upstream-model helpers.

→ `coverage-all-models.test.js` picks up registered catalog changes without duplicating model lists in tests. This is structural coverage (truthy translation output and configured image stripping), not validation of every model's upstream behavior.

Add dedicated preservation or executor tests when a change affects behavior beyond the catalog smoke, especially protocol, auth or media-specific paths (see §7).

## 5. Translator registration

`open-sse/translator/index.js` now has static side-effect imports that work under ESM and the app bundler. Its `ensureInitialized()` and exported `initTranslators()` are no-ops because registration already happens at import time. The `require()` explanation in `registerAll.js` is historical, not the current production loader.

Existing tests may keep `import "./registerAll.js"` for explicit registration. When adding a translator, update the production static imports and keep that helper's import list aligned. Assert actual translated fields/stream events rather than only that a call does not throw; an unregistered route can otherwise look like a successful passthrough.

## 6. Bug-exposure convention — `it.fails`

- A bug confirmed in the app but NOT yet fixed → use `it.fails(...)`.
- `it.fails` **passes while the app still has the bug**, **turns red once the bug is fixed** → a reminder to update the test (switch `it.fails` → `it` and confirm correct behavior).
- Pattern for a new bug-exposure test: real input → assert the "should-be-kept" behavior → wrap in `it.fails` + a comment with the source `file:line`.

## 7. Special formats to watch

- `kiro` (binary AWS EventStream), `cursor` (protobuf ConnectRPC), `commandcode` (NDJSON) → responses do NOT round-trip cleanly through openai; test via their executors, not just the translator.
- Multi-format providers require more than the matrix's target-format fallback: `opencode-go` declares model-specific `supportedFormats` across chat, Claude and Responses transports; `xiaomi-tokenplan` supports region-dependent OpenAI/Claude endpoints and a Claude model alias. GitHub can fall back from chat-completions to Responses at runtime. Exercise the transport-selection/executor path as well as direct translation.
- System-message merging, reasoning signatures, media and tool-error metadata need preservation assertions for each relevant route, including direct routes and bridge fallbacks.

## 8. Regression navigation

The `bugs-*.test.js` files mix ordinary regression tests and expected-failure assertions; the test declarations are the current source of truth. Do not assume every case in a file named `bugs-*` is still unfixed or rely on historical source-line tables.

| Test file | Preservation contract |
|---|---|
| `bugs-openai-bridge.test.js`, `bugs-claudeCode-context.test.js` | Claude system/thinking/media/tool-result metadata |
| `bugs-toClaude-context.test.js` | Claude target tool choice, reasoning and token budgets |
| `bugs-codexCli-responses.test.js` | Responses call IDs, arguments, images and instructions |
| `bugs-antigravity.test.js` | Mixed tool events, signatures, schema cleanup and stream indices |
| `bugs-kiro.test.js` | Kiro arguments, token limits and media |
| `bugs-gemini-cursor-commandcode.test.js` | System-message merging and native-format content |

When fixing a defect, verify the matching preservation assertion, switch its `it.fails` to `it` if appropriate, and add the affected direct/bridge or executor path if existing coverage only exercises another route.
