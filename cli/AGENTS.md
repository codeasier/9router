# CLI launcher and npm bundle

Inherits [repository guidance](../AGENTS.md). This package is the published `9router` launcher, not the gateway implementation. Its executable is `cli.js`; HTTP routes and provider behavior are built from the repository root into `app/`.

## Entry points

| Path | Responsibility |
|---|---|
| `package.json`, `cli.js` | npm bin, launch arguments, update flow, process startup and shutdown |
| `src/cli/` | Interactive terminal UI, tray implementations and CLI subcommands |
| `hooks/postinstall.js` | Best-effort SQLite/tray runtime warm-up |
| `hooks/sqliteRuntime.js` | User-writable runtime dependency installation and child `NODE_PATH` |
| `hooks/trayRuntime.js` | macOS/Linux tray dependency and pinned macOS arm64 binary overlay |
| `scripts/build-cli.js` | Gateway build and bundle assembly |
| `scripts/buildMitm.js` | Self-contained MITM server bundle inside the CLI app |

`--port`/`-p` and `--host`/`-H` are parsed in `cli.js` and passed as `PORT`/`HOSTNAME` to the child process. Defaults are `20128` and `0.0.0.0`; `--host 127.0.0.1` selects local-only binding. The launcher prefers `app/custom-server.js` and otherwise falls back to `app/server.js`. The wrapper must be included in new bundles to preserve the root IP/auth contract.

The `xai video` subcommand uses an already running gateway and exits before launcher self-healing/server startup. Keep its API client behavior separate from launcher process management.

## Build and package lifecycle

**Build side effects:** `scripts/build-cli.js` can rewrite the root `package.json` version from this package. It recursively deletes and recreates `app/`, or the directory supplied by `NINEROUTER_CLI_APP_DIR`. Treat that override as a disposable bundle destination. `scripts/buildMitm.js` also removes plain MITM files from that generated bundle after bundling.

Commands below run from `cli/`, after root gateway and local CLI build dependencies are installed:

| Command | Effect |
|---|---|
| `npm run build` | Builds the gateway and assembles the launcher bundle |
| `npm run dev` | Nodemon launcher watch; requires an existing app bundle and can affect running processes/runtime data |
| `npm run pack:cli` | Builds, then creates the npm tarball in the repository root |
| `npm run publish:cli` | Builds and publishes; `prepublishOnly` also invokes the build |

The root `npm run cli:pack` delegates to `pack:cli`. Do not treat a packaging command as a cheap documentation check.

Assembly order matters:

1. Use `cli/.build-home/` for build-time home/AppData and root `.next-cli-build/` for Next output, with `NEXT_TRACING_ROOT_MODE=workspace`.
2. Locate standalone output, including the project-basename nested layout and the older nested `app/` layout, then copy it to the CLI app destination.
3. Copy `custom-server.js`; ensure `sql.js` and external `open` are available in the bundle; remove bundled native `better-sqlite3`.
4. Copy static assets and `public/`, then merge the **complete generated server tree**, not only trace-pruned standalone files. Assert that chat-completions and messages route artifacts exist.
5. Copy MITM and headless updater sources, then bundle/minify the MITM server with esbuild and remove its unused plain source files.

The npm `files` list includes `cli.js`, `src`, `hooks`, `app`, README and license. Build scripts are source-checkout tooling, not part of that published list.

## Installation and platform differences

- `postinstall` and normal launcher startup may invoke npm or download tray assets. Even `cli.js --help` reaches runtime self-healing before parsing options; it is not a side-effect-free verification command.
- SQLite native dependencies live in the resolved user data directory's `runtime/node_modules`, outside the global npm installation, to avoid Windows update locks. Preserve the runtime and bundled module search paths supplied by `buildEnvWithRuntime`.
- Windows uses PowerShell NotifyIcon. macOS/Linux lazy-install `systray2`; macOS arm64 additionally verifies and overlays a pinned executable. URL, checksum, binary architecture checks and the [tray workflow](../.github/workflows/tray-binaries.yml) must agree when changing that artifact.
- Launcher startup can terminate existing application/port processes. Inspect its cleanup paths before using it to probe a bundle.

## Focused verification and coupled changes

From the repository root, the existing helper test can run without the gateway build or Vitest installation:

```bash
node --test tests/unit/cli-build-artifacts.test.js
```

It exercises copying and route-artifact checks with temporary fixtures. With the [test package](../tests/AGENTS.md) installed, run from `tests/`:

```bash
npx vitest run unit/cli-build-artifacts.test.js unit/standalone-assets.test.js
```

For CLI video command changes, use `unit/cli-xai-video.test.js`. Packaging changes must preserve server-layout detection, complete route/chunk copies, wrapper placement, SQLite WASM availability and the separately bundled MITM child process. Compare runtime changes with `../next.config.mjs`, `../Dockerfile` and `../scripts/copy-standalone-assets.mjs`.
