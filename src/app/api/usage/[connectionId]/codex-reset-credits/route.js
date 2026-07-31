import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import {
  findExpiringCodexResetCredit,
  getCodexResetCreditInventory,
  MAX_CODEX_RESET_AUTO_USE_MINUTES,
  useCodexResetCredit,
} from "@/shared/services/codexResetCreditAutoUse";

export { findExpiringCodexResetCredit };

async function getCodexConnection(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) {
    return { response: Response.json({ error: "Connection not found" }, { status: 404 }) };
  }
  if (connection.provider !== "codex") {
    return { response: Response.json({ error: "Codex reset credits are only available for Codex connections." }, { status: 400 }) };
  }
  if (!["oauth", "access_token"].includes(connection.authType)) {
    return { response: Response.json({ error: "Codex reset credits require an OAuth or access-token connection." }, { status: 400 }) };
  }
  return { connection };
}

function responseForUse(outcome) {
  if (outcome.state === "confirmed") {
    const result = outcome.result || {};
    return Response.json({
      code: result.code || "reconciled_confirmed",
      reset: true,
      windows_reset: result.windowsReset || 0,
      redeemRequestId: outcome.attempt?.redeemRequestId,
      credit: result.raw?.credit || null,
    });
  }
  if (outcome.state === "no_credit") {
    return Response.json({
      code: "no_credit",
      reset: false,
      windows_reset: outcome.result?.windowsReset || 0,
      message: "No Codex reset credits available.",
    }, { status: 409 });
  }
  if (["not_due", "unstable_identity", "already_consumed", "disabled"].includes(outcome.state)) {
    return Response.json({ code: outcome.state, reset: false, auto: true });
  }
  if (outcome.state === "auth_required") {
    return Response.json({
      code: "auth_required",
      reset: false,
      redeemRequestId: outcome.attempt?.redeemRequestId,
      message: outcome.result?.message || "Codex authorization must be refreshed before this attempt can continue.",
    }, { status: 401 });
  }
  if (["unknown", "expired_unresolved"].includes(outcome.state)) {
    return Response.json({
      code: outcome.state,
      reset: false,
      redeemRequestId: outcome.attempt?.redeemRequestId,
      message: "The reset-credit outcome is unresolved; the persisted request id will be reconciled before another attempt.",
    }, { status: 503 });
  }
  const result = outcome.result || {};
  return Response.json({
    code: result.code || outcome.state || "unknown_response",
    reset: false,
    windows_reset: result.windowsReset || 0,
    message: result.message || "Codex reset credit consume returned an unexpected response.",
  }, { status: result.status >= 400 && result.status < 500 ? result.status : 502 });
}

export async function GET(_request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const resolved = await getCodexConnection(connectionId);
    if (resolved.response) return resolved.response;
    connection = resolved.connection;
    return Response.json(await getCodexResetCreditInventory(connection));
  } catch (error) {
    console.warn(`[Codex Reset Credits] ${connection?.id || "unknown"}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  let connection;
  try {
    const rawBody = await request.text();
    let body = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }
    }
    const auto = Object.prototype.hasOwnProperty.call(body, "autoUseBeforeExpiryMinutes");
    const rawThreshold = auto ? Number(body.autoUseBeforeExpiryMinutes) : 0;
    const thresholdMinutes = Math.round(rawThreshold);
    if (auto && !Number.isFinite(rawThreshold)) {
      return Response.json({ error: "autoUseBeforeExpiryMinutes must be a number." }, { status: 400 });
    }
    if (auto && (thresholdMinutes < 1 || thresholdMinutes > MAX_CODEX_RESET_AUTO_USE_MINUTES)) {
      return Response.json({ error: `autoUseBeforeExpiryMinutes must be between 1 and ${MAX_CODEX_RESET_AUTO_USE_MINUTES}.` }, { status: 400 });
    }

    const { connectionId } = await params;
    const resolved = await getCodexConnection(connectionId);
    if (resolved.response) return resolved.response;
    connection = resolved.connection;
    const outcome = await useCodexResetCredit(connection, { auto, thresholdMinutes });
    return responseForUse(outcome);
  } catch (error) {
    console.warn(`[Codex Reset Credits] ${connection?.id || "unknown"}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
