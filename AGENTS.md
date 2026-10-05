# 9Router

9Router is a Next.js dashboard and local AI gateway. The private root package (`9router-app`) runs the gateway; the published `9router` package in `cli/` launches a bundled copy. `gitbook/` is an independently built static documentation site. These are separate npm packages, not a configured npm workspace.

## Ownership and navigation

| Change | Entry points and guidance |
|---|---|
| Dashboard or management API | `src/app/dashboard/`, `src/app/api/`, shared UI in `src/shared/` |
| Compatibility endpoint or account/combo selection | `next.config.mjs`, `src/app/api/v1/`, `src/app/api/v1beta/`, `src/sse/handlers/chat.js` |
| Upstream protocol, model catalog, translation, token refresh | [open-sse/AGENTS.md](open-sse/AGENTS.md) |
| State, usage, request details, schema migration | [src/lib/db/AGENTS.md](src/lib/db/AGENTS.md) |
| CLI packaging, launcher, tray, runtime dependencies | [cli/AGENTS.md](cli/AGENTS.md) |
| Test setup, discovery, regression baselines | [tests/AGENTS.md](tests/AGENTS.md), then [translator tests](tests/translator/AGENTS.md) |
| Published documentation site | [gitbook/AGENTS.md](gitbook/AGENTS.md) |
| Production image and startup | `Dockerfile`, `docker-compose.yml`, `custom-server.js`, `scripts/copy-standalone-assets.mjs` |

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system context, then verify details against implementation. Its JSON persistence diagrams and some commands in [CLAUDE.md](CLAUDE.md) describe older behavior; the storage and script distinctions below are important.

## Cross-repository contracts

- Application code is plain JavaScript. Root [jsconfig.json](jsconfig.json) maps `@/*` to `src/*` and `open-sse/*` to the engine. The documentation site has its own alias root.
- Preserve the app/engine boundary: routes call app-side handlers for authentication, persistence and account selection, then dispatch to `open-sse` with resolved model information and credentials. Read the engine guide before editing that subtree.
- Provider transport, models and display metadata originate in `open-sse/providers/registry/`; configuration barrels are derived views, not separate catalogs to maintain.
- New persistence consumers import `@/lib/db/index.js`. Both `src/lib/localDb.js` and `src/lib/usageDb.js` are compatibility shims. State, usage and request details share SQLite and follow the resolved `DATA_DIR`.
- Preserve `custom-server.js` in production startup and packaging. It stamps socket-derived IP information with a per-process proof token, strips spoofable forwarding/proof headers and trusts forwarded client IPs only from loopback peers. Bare Next development startup does not install this wrapper.
- Provider credentials, database exports and request-detail/debug logs are sensitive. Keep API response sanitization and key masking consistent with auth and usage consumers; use [.env.example](.env.example) for the environment contract and replace its sample secrets before deployment.
- Inspect wrapper scripts before building or generating files. CLI packaging can change the root version and delete its output directory; provider maintenance scripts are not read-only validation commands.

## Gateway development and build

Run the following from the repository root. `npm install` accesses the registry and may run dependency installation hooks; `better-sqlite3` is optional, with other SQLite drivers available. Create a local `.env` from the example only if one does not already exist, and choose a writable `DATA_DIR` and base URLs matching the selected port.

| Command | Actual target |
|---|---|
| `npm run dev` | Next development server with explicit port `20127` |
| `npm run dev:webpack` | Webpack development server with explicit port `20127` |
| `npm run build` | Webpack production build into `.next/` by default, followed by the asset-copy postbuild hook |
| `npm run start` | Root `custom-server.js`, forwarding `--port 20127` to Next when no adjacent standalone `server.js` exists |
| `PORT=20128 HOSTNAME=127.0.0.1 node .next/standalone/custom-server.js` | Default standalone production output, using its environment-configured port/host |
| `npx eslint .` | Root ESLint configuration; there is no root lint or test script |

The root dev/start scripts explicitly pass a port: do not assume that setting `PORT=20128` alone changes them. CLI and Docker defaults are `20128`. The shell environment example above uses POSIX syntax.

`next.config.mjs` controls `NEXT_DIST_DIR`, standalone tracing and `/v1/*` → `/api/v1/*` rewrites. The postbuild hook copies static assets, `public/` and the server wrapper into default standalone output; it skips workspace-traced CLI builds because CLI packaging owns those copies. Docker additionally copies engine, MITM and runtime dependencies that tracing can omit. Keep these packaging paths consistent when changing runtime imports.

Bun variants are declared in the root package: `dev:bun` uses Webpack, `build:bun` has its own postbuild hook, and `start:bun` launches the default standalone wrapper. They do not have exactly the same startup path as root `start`.

## Change-together checks

- Endpoint changes: route/rewrite → app handler → engine protocol handling → client-format tests. The chat path is `src/app/api/v1/chat/completions/route.js` → `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` → executor/translator → response.
- Storage changes: schema/migration → repository API → compatibility exports and endpoint/UI consumers; fork-only migrations use their own namespace.
- Runtime dependency/startup changes: standalone postbuild → Docker copies → CLI build/runtime hooks → packaging tests.
- Root and CLI versions live in separate manifests, but the CLI build synchronizes the root version from `cli/package.json`. Check this side effect before packaging; release notes live in [CHANGELOG.md](CHANGELOG.md).
- Use focused tests from the tests guide. Legacy full-suite baselines have path and collection limitations; a raw full-suite red result or an empty test run is not sufficient regression evidence.
