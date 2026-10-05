# Test package

Inherits [repository guidance](../AGENTS.md). `tests/` is an independent ESM npm package with Vitest, not a root `npm test` target. [README.md](README.md) describes the older embeddings-only scope; test discovery now includes unit and translator suites.

## Setup and discovery

Install root gateway dependencies first, then install this package's dependencies from `tests/`. Tests import application modules that need root dependencies as well as Vitest. Installers access the registry and can execute dependency hooks.

Run from `tests/` after installation:

```bash
npm test
npx vitest run unit/capabilities.test.js
npx vitest run translator/format-roundtrip.test.js
```

`package.json` currently uses ordinary `vitest run --reporter=verbose`; it does not require a hardcoded `NODE_PATH`. `vitest.config.js` uses the Node environment, matches `**/*.test.js` and excludes dependencies, `.claude/`, `.worktrees/` and `dist/`. Its aliases resolve `@/` to root `src/` and `open-sse` to the root engine independently of the test package's location.

For a runner invoked from the repository root, explicitly select `tests/vitest.config.js` and use `tests/...` filters. Running from `tests/` is the simplest way to use its installed runner; root package dependencies do not include Vitest.

## Ownership and focused targets

| Change | Relevant tests |
|---|---|
| Provider/model capabilities | `unit/capabilities*.test.js`, `unit/combo-capabilities.test.js` |
| Model-specific transport/thinking overrides | `unit/model-overrides.test.js`, `unit/model-overrides-chatcore.test.js` |
| Request/response conversion | [translator/AGENTS.md](translator/AGENTS.md), `unit/translator-*.test.js` |
| SQLite selection and migration | `unit/db-driver-chain.test.js`, `unit/db-migration-chain.test.js` |
| Packaging and standalone assets | `unit/cli-build-artifacts.test.js`, `unit/standalone-assets.test.js` |
| Cursor token compression ordering | `unit/rtk-cursor-pretranslate.test.js` |

Inspect each file's setup before running it. Database tests should select a temporary `DATA_DIR` before importing persistence modules, close adapters and reset module/global state. That prevents importing singleton state against a real user's database.

## Live data and expected failures

- Translator live-provider tests are opt-in; read their [local guide](translator/AGENTS.md) for `RUN_REAL`, the separate NVIDIA `RUN_E2E` gate and credential sources. These runs can refresh tokens, write usage and consume upstream quota.
- `unit/embeddings.cloud.test.js` imports `../../cloud/src/handlers/embeddings.js`, but the cloud worker implementation is absent from this checkout. Its collection failure is distinct from a failed assertion.
- `unit/xai-oauth-service.test.js` stubs global `fetch` for endpoint discovery/token exchange. Preserve that mock through imports and module resets; historical timeout notes are not evidence that the current test intentionally calls xAI.
- Some translator tests use `it.fails` to encode an unfixed defect. A newly passing assertion makes that test red until it is changed to an ordinary `it`. Do not remove the assertion just to restore green.
- [__baseline__/known-fails.txt](__baseline__/known-fails.txt) is historical evidence, not a promise about the exact current failure set. Use a same-environment base-versus-change comparison for failures not represented accurately there.

## Baseline scripts

From the repository root, these commands compare current derived config with committed snapshots:

```bash
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
```

The providers checker intentionally omits fields in its `ADDED_FIELDS` set; dedicated tests must cover those fields. Alias/OAuth `--snapshot` and `snapshot-providers.mjs` write baselines: do not use them as acceptance checks or regenerate snapshots merely to hide unexpected differences.

`verify-no-regression.mjs` consumes a Vitest JSON report, but derives names using `f.name.split("/app/")[1]`. That does not normalize ordinary worktree paths. It also examines `assertionResults` only, so collection failures can be missed. Inspect the report's suite-level errors and normalize paths against the historical `tests/... :: fullName` identifiers before relying on this legacy gate; do not call its zero-regression result proof of full-suite success.
