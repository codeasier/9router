export const DEFAULT_CODEX_RESET_AUTO_USE_MINUTES = 10;
export const MAX_CODEX_RESET_AUTO_USE_MINUTES = 10080;

export function normalizeCodexResetAutoUseMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_CODEX_RESET_AUTO_USE_MINUTES, Math.max(1, Math.round(parsed)));
}

export function findExpiringCodexResetCredit(result, thresholdMinutes, now = Date.now()) {
  if (!result || result.availableCount <= 0) return null;
  const thresholdMs = thresholdMinutes * 60 * 1000;
  return (Array.isArray(result.credits) ? result.credits : [])
    .filter((credit) => String(credit?.status || "").toLowerCase() === "available")
    .map((credit) => ({ credit, expiresAtMs: new Date(credit.expiresAt).getTime() }))
    .filter(({ expiresAtMs }) => Number.isFinite(expiresAtMs) && expiresAtMs > now && expiresAtMs - now <= thresholdMs)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)[0]?.credit || null;
}
