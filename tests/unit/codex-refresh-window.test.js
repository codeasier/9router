import { describe, expect, it } from "vitest";
import { getRefreshLeadMs } from "../../open-sse/services/tokenRefresh.js";
import {
  CODEX_MAX_REFRESH_AGE_MS,
  mergeRefreshedCredentials,
  shouldRefreshCredentials,
} from "../../open-sse/services/oauthCredentialManager.js";

const now = Date.parse("2026-10-17T12:00:00Z");
const freshCredentials = () => ({
  refreshToken: "mock-refresh-token",
  expiresAt: new Date(now + 3600000).toISOString(),
  lastRefreshAt: new Date(now).toISOString(),
});

describe("Codex access-token refresh window", () => {
  it("uses the official ten-minute refresh lead", () => {
    expect(getRefreshLeadMs("codex")).toBe(600000);
  });
  it("does not refresh a fresh one-hour access token", () => {
    expect(shouldRefreshCredentials("codex", freshCredentials(), now)).toBe(false);
  });
  it("does not immediately refresh a just-refreshed one-hour token", () => {
    const merged = mergeRefreshedCredentials("codex", freshCredentials(), {
      accessToken: "mock-access-token", expiresIn: 3600,
    }, now);
    expect(merged.lastRefreshAt).toBe(new Date(now).toISOString());
    expect(shouldRefreshCredentials("codex", merged, now + 1000)).toBe(false);
  });
  it("still refreshes an access token inside the expiry window", () => {
    const credentials = freshCredentials();
    credentials.expiresAt = new Date(now + 599999).toISOString();
    expect(shouldRefreshCredentials("codex", credentials, now)).toBe(true);
  });
  it("retains the independent eight-day stale refresh policy", () => {
    expect(CODEX_MAX_REFRESH_AGE_MS).toBe(691200000);
    const credentials = freshCredentials();
    credentials.lastRefreshAt = new Date(now - CODEX_MAX_REFRESH_AGE_MS).toISOString();
    expect(shouldRefreshCredentials("codex", credentials, now)).toBe(true);
  });
});
