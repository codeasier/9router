// Trae ExchangeToken responses. Personal CN returns Result as the JWT string.
// International returns Result.AccessToken. The enterprise console returns
// Data.Token and millisecond expiry fields. A non-zero `code` is a failure.

function unixSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value / 1000);
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

export function traeTokenFromExchangePayload(data) {
  if (!data || typeof data !== "object") return null;
  const code = data.code ?? data.Code;
  if (typeof code === "number" && code !== 0) return null;
  const result = data.Result ?? data.result ?? data.Data ?? data.data;
  if (typeof result === "string" && result.trim()) {
    return { accessToken: result.trim(), refreshToken: null, expiresAt: null };
  }
  const record = result && typeof result === "object" && !Array.isArray(result) ? result : null;
  if (!record) return null;
  const accessToken = [
    record.AccessToken, record.accessToken, record.access_token,
    record.Token, record.token, record.Jwt, record.jwt, record.UserJwt, record.userJwt,
  ].find((value) => typeof value === "string" && value.trim());
  if (!accessToken) return null;
  const refreshToken = record.RefreshToken || record.refreshToken || record.refresh_token || null;
  const expiresAt = unixSeconds(
    record.ExpiresAt || record.expiresAt || record.ExpiredAt || record.expiredAt
    || record.TokenExpireAt || record.tokenExpireAt,
  );
  return {
    accessToken: accessToken.trim(),
    refreshToken: typeof refreshToken === "string" && refreshToken.trim() ? refreshToken.trim() : null,
    expiresAt,
  };
}
