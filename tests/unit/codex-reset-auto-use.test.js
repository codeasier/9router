import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_RESET_AUTO_USE_MINUTES,
  normalizeCodexResetAutoUseMinutes,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { findExpiringCodexResetCredit } from "@/shared/services/codexResetCreditUtils.js";

describe("Codex reset credit auto-use helpers", () => {
  it("normalizes the browser threshold", () => {
    expect(DEFAULT_CODEX_RESET_AUTO_USE_MINUTES).toBe(10);
    expect(normalizeCodexResetAutoUseMinutes(null)).toBe(0);
    expect(normalizeCodexResetAutoUseMinutes("10")).toBe(10);
    expect(normalizeCodexResetAutoUseMinutes("1.6")).toBe(2);
    expect(normalizeCodexResetAutoUseMinutes("0")).toBe(0);
    expect(normalizeCodexResetAutoUseMinutes("20000")).toBe(10080);
  });

  it("selects the earliest future available credit inside the threshold", () => {
    const now = Date.parse("2026-07-26T00:00:00Z");
    const due = findExpiringCodexResetCredit({
      availableCount: 2,
      credits: [
        { status: "available", expiresAt: "2026-07-26T00:09:00Z" },
        { status: "redeemed", expiresAt: "2026-07-26T00:01:00Z" },
        { status: "available", expiresAt: "2026-07-26T00:05:00Z" },
      ],
    }, 10, now);

    expect(due?.expiresAt).toBe("2026-07-26T00:05:00Z");
  });

  it("ignores expired, malformed, unavailable, and not-yet-due credits", () => {
    const now = Date.parse("2026-07-26T00:00:00Z");
    expect(findExpiringCodexResetCredit({
      availableCount: 4,
      credits: [
        { status: "available", expiresAt: "2026-07-25T23:59:00Z" },
        { status: "available", expiresAt: "bad-date" },
        { status: "redeemed", expiresAt: "2026-07-26T00:05:00Z" },
        { status: "available", expiresAt: "2026-07-26T00:11:00Z" },
      ],
    }, 10, now)).toBeNull();
  });
});
