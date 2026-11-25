import { describe, expect, it } from "vitest";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getModelInfoCore, parseModel } from "../../open-sse/services/model.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";
import { codexResetAutoUseSettingsKey } from "../../src/shared/services/codexResetCreditUtils.js";
import {
  clearCodexSession,
  getCodexSessionStatus,
  registerCodexSession,
} from "../../src/lib/oauth/utils/server.js";

describe("OpenAI Codex (Backup)", () => {
  it("publishes an isolated provider that shares Codex oauth, models, and pricing", () => {
    expect(AI_PROVIDERS["codex-backup"]).toMatchObject({
      id: "codex-backup",
      alias: "cx-new",
      name: "OpenAI Codex (Backup)",
      priority: 31,
    });
    expect(PROVIDERS["codex-backup"].baseUrl).toBe(PROVIDERS.codex.baseUrl);
    expect(PROVIDERS["codex-backup"].format).toBe(PROVIDERS.codex.format);
    expect(PROVIDER_OAUTH["codex-backup"]).toBe(PROVIDER_OAUTH.codex);
    expect(PROVIDERS["codex-backup"].usage).toEqual(PROVIDERS.codex.usage);
    expect(PROVIDER_MODELS["cx-new"].map((model) => model.id)).toEqual(
      PROVIDER_MODELS.cx.map((model) => model.id),
    );
    expect(getPricingForModel("codex-backup", "gpt-6.1-sol")).toEqual(
      getPricingForModel("codex", "gpt-6.1-sol"),
    );
    expect(getCapabilitiesForModel("codex-backup", "gpt-6.1-sol")).toEqual(
      getCapabilitiesForModel("codex", "gpt-6.1-sol"),
    );
    expect(getThinkingLevels("codex-backup", "gpt-6.1-sol")).toEqual(
      getThinkingLevels("codex", "gpt-6.1-sol"),
    );
    expect(getThinkingLevels("cx-new", "gpt-5.6-sol")).toEqual(
      getThinkingLevels("cx", "gpt-5.6-sol"),
    );
  });

  it("routes cx-new models to the backup and leaves bare gpt ids on codex", async () => {
    expect(parseModel("cx-new/gpt-6.1-sol").provider).toBe("codex-backup");
    expect(parseModel("cx/gpt-6.1-sol").provider).toBe("codex");
    expect((await getModelInfoCore("gpt-6.1-sol", {})).provider).toBe("codex");
  });

  it("uses a separate executor whose catalog alias is cx-new", () => {
    const backup = getExecutor("codex-backup");
    const original = getExecutor("codex");
    const alias = getExecutor("cx-new");
    expect(backup).not.toBe(original);
    expect(backup.provider).toBe("codex-backup");
    expect(backup.modelAlias).toBe("cx-new");
    expect(alias.provider).toBe("codex-backup");
    expect(alias).not.toBe(original);
    expect(getModelUpstreamId("cx-new", "gpt-5.6-sol-review")).toBe(
      getModelUpstreamId("cx", "gpt-5.6-sol-review"),
    );
    expect(getModelUpstreamId("cx-new", "gpt-6.2-sol[1m]")).toBe(
      getModelUpstreamId("cx", "gpt-6.2-sol[1m]"),
    );
  });

  it("stores the login provider on the shared callback session", () => {
    const backupState = "codex-backup-session-test";
    expect(registerCodexSession({
      state: backupState,
      codeVerifier: "verifier-backup",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      provider: "codex-backup",
    })).toBe(true);
    expect(getCodexSessionStatus(backupState)?.provider).toBe("codex-backup");
    clearCodexSession(backupState);

    const originalState = "codex-session-test";
    registerCodexSession({
      state: originalState,
      codeVerifier: "verifier-original",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      provider: "other",
    });
    expect(getCodexSessionStatus(originalState)?.provider).toBe("codex");
    clearCodexSession(originalState);
  });

  it("keeps reset-credit auto-use settings on separate keys", () => {
    expect(codexResetAutoUseSettingsKey("codex")).toBe("codexResetCreditAutoUseMinutes");
    expect(codexResetAutoUseSettingsKey("codex-backup")).toBe("codexBackupResetCreditAutoUseMinutes");
    expect(codexResetAutoUseSettingsKey("cx-new")).toBe("codexResetCreditAutoUseMinutes");
  });
});
