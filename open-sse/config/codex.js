// Codex CLI identity for chatgpt.com/backend-api/codex/*.
// Single source of truth is the registry entry (providers/registry/codex.js
// transport.cliVersion); appConstants re-exports it as CODEX_CLI_VERSION.
// Official openai/codex models.json gates models by `minimal_client_version`:
// gpt-5.6-sol/terra/luna require 0.144.0; gpt-6-astra requires 0.153.0.
import { CODEX_CLI_VERSION } from "./appConstants.js";

export const CODEX_ORIGINATOR = "codex_cli_rs";
export const CODEX_CLIENT_VERSION = CODEX_CLI_VERSION;
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`;
