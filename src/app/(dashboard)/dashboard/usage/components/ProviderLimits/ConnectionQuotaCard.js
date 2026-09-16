"use client";

import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import Card from "@/shared/components/Card";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import {
  filterQuotasForCard,
  getHiddenQuotaRows,
  getQuotaVisibilityKey,
  getConnectionLabel,
} from "./utils";

const KIRO_METHOD_LABELS = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

const AUTO_PING_TOOLTIPS = {
  claude: "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.",
  codex: "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota.",
};

function kiroMethodLabel(conn) {
  const m = conn.providerSpecificData?.authMethod;
  if (m && KIRO_METHOD_LABELS[m]) return KIRO_METHOD_LABELS[m];
  return conn.authType === "api_key" ? "API Key" : "OAuth";
}

function kiroRegion(conn) {
  const r = conn.providerSpecificData?.region;
  if (r) return r;
  const arn = conn.providerSpecificData?.profileArn;
  const seg = typeof arn === "string" ? arn.split(":")[3] : "";
  return seg || "";
}

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function getConnectionSecondaryLabel(connection) {
  if (connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()) {
    return connection.email.trim();
  }

  if (connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()) {
    return connection.displayName.trim();
  }

  return null;
}

export default function ConnectionQuotaCard({
  conn,
  quota,
  isLoading,
  error,
  quotaVisibility,
  quotaSortMode,
  autoPingMaps,
  copied,
  copy,
  deletingId,
  togglingId,
  resettingLimitId,
  onResetConfirm,
  onViewCodexResetCredits,
  onToggleAutoPing,
  onOpenVolceapiDetails,
  onRefresh,
  onEdit,
  onDelete,
  onToggleActive,
  onHideQuota,
  onShowQuota,
}) {
  const isInactive = conn.isActive === false;
  const isCodex = conn.provider === "codex";
  const resetCreditCount = getCodexResetCreditCount(quota);
  const isResettingLimit = resettingLimitId === conn.id;
  const rowBusy = deletingId === conn.id || togglingId === conn.id || isResettingLimit;
  const rawQuotas = quota?.quotas || [];
  const visibleQuotas = filterQuotasForCard(conn.provider, rawQuotas, quotaVisibility);
  const hiddenQuotaRows = getHiddenQuotaRows(conn.provider, rawQuotas, quotaVisibility);
  const tokenRows = rawQuotas.filter((row) => row?.budgetKind === "tokens");
  const showTokenDetailsHint = !isLoading && !error && !quota?.message && tokenRows.length > 0 && visibleQuotas.length === 0;

  return (
    <Card
      padding="none"
      className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
    >
      <div className="px-3 py-2 border-b border-black/10 dark:border-white/10">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
              <ProviderIcon
                src={`/providers/${conn.provider}.png`}
                alt={conn.provider}
                size={32}
                className="object-contain"
                fallbackText={
                  conn.provider?.slice(0, 2).toUpperCase() || "PR"
                }
              />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary truncate">
                {AI_PROVIDERS[conn.provider]?.name || conn.provider}
              </h3>
              {getConnectionLabel(conn) ? (
                <p className="text-xs text-text-muted truncate">
                  {getConnectionLabel(conn)}
                </p>
              ) : null}
              {getConnectionSecondaryLabel(conn) ? (
                <p className="text-[11px] text-text-muted/80 truncate">
                  {getConnectionSecondaryLabel(conn)}
                </p>
              ) : null}
              {conn.provider === "kiro" && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                    {kiroMethodLabel(conn)}
                  </span>
                  {kiroRegion(conn) && (
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                      {kiroRegion(conn)}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      isInactive
                        ? "bg-surface-2 text-text-muted"
                        : conn.testStatus === "active" || conn.testStatus === "success"
                          ? "bg-green-500/10 text-green-600 dark:text-green-400"
                          : conn.testStatus === "error" || conn.testStatus === "expired" || conn.testStatus === "unavailable"
                            ? "bg-red-500/10 text-red-600 dark:text-red-400"
                            : "bg-surface-2 text-text-muted"
                    }`}
                  >
                    {isInactive ? "disabled" : conn.testStatus || "unknown"}
                  </span>
                  {conn.providerSpecificData?.profileArn && (
                    <button
                      type="button"
                      onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                      title={conn.providerSpecificData.profileArn}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                    >
                      <span className="material-symbols-outlined text-[12px]">
                        {copied === conn.id ? "check" : "content_copy"}
                      </span>
                      <code className="truncate font-mono">
                        {conn.providerSpecificData.profileArn}
                      </code>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isCodex && (
              <>
                <Tooltip
                  text={
                    resetCreditCount > 0
                      ? `Use one Codex reset credit. Available: ${resetCreditCount}`
                      : "No Codex reset credits available"
                  }
                >
                  <button
                    type="button"
                    onClick={() => onResetConfirm({ connection: conn, resetCreditCount })}
                    disabled={resetCreditCount <= 0 || isLoading || rowBusy}
                    aria-label={
                      resetCreditCount > 0
                        ? `Use one Codex reset credit. ${resetCreditCount} available.`
                        : "No Codex reset credits available"
                    }
                    className={`flex h-8 min-w-10 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:cursor-not-allowed disabled:opacity-60 ${
                      resetCreditCount > 0
                        ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                        : "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]"
                    }`}
                  >
                    <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                      {isResettingLimit ? "progress_activity" : "restart_alt"}
                    </span>
                    <span>{resetCreditCount}</span>
                  </button>
                </Tooltip>
                <Tooltip text="View Codex reset credit expiry">
                  <button
                    type="button"
                    onClick={() => onViewCodexResetCredits(conn)}
                    disabled={isLoading || rowBusy}
                    aria-label="View Codex reset credit expiry"
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
                  >
                    <span className="material-symbols-outlined text-[17px]">schedule</span>
                  </button>
                </Tooltip>
              </>
            )}
            {AUTO_PING_SETTINGS_KEYS[conn.provider] && conn.authType === "oauth" && (
              <Tooltip text={AUTO_PING_TOOLTIPS[conn.provider]}>
                <button
                  type="button"
                  onClick={() => onToggleAutoPing(conn.id, conn.provider, !(autoPingMaps[conn.provider]?.[conn.id] === true))}
                  aria-label="Toggle auto-ping"
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPingMaps[conn.provider]?.[conn.id] === true ? "text-primary" : "text-text-muted"}`}
                >
                  <span className="material-symbols-outlined text-[18px]">bolt</span>
                </button>
              </Tooltip>
            )}
            {conn.provider === "volceapi" && quota?.raw?.details && (
              <Tooltip text="View model, token, and provider usage">
                <button
                  type="button"
                  onClick={() => onOpenVolceapiDetails({ connection: conn, details: quota.raw.details, note: quota.raw.note })}
                  disabled={isLoading || rowBusy}
                  aria-label="View 火山网关 usage details"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[17px]">analytics</span>
                </button>
              </Tooltip>
            )}
            <Tooltip text="Refresh quota">
              <button
                type="button"
                onClick={() => onRefresh(conn.id, conn.provider)}
                disabled={isLoading || rowBusy}
                aria-label="Refresh quota"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                <span
                  className={`material-symbols-outlined text-[18px] text-text-muted ${isLoading ? "animate-spin" : ""}`}
                >
                  refresh
                </span>
              </button>
            </Tooltip>
            <Tooltip text="Edit connection">
              <button
                type="button"
                onClick={() => onEdit(conn)}
                disabled={rowBusy}
                aria-label="Edit connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">
                  edit
                </span>
              </button>
            </Tooltip>
            <Tooltip text="Delete connection">
              <button
                type="button"
                onClick={() => onDelete(conn.id)}
                disabled={rowBusy}
                aria-label="Delete connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                >
                  delete
                </span>
              </button>
            </Tooltip>
            <div
              className="inline-flex items-center pl-0.5"
              title={
                (conn.isActive ?? true)
                  ? "Disable connection"
                  : "Enable connection"
              }
            >
              <Toggle
                size="sm"
                checked={conn.isActive ?? true}
                disabled={rowBusy}
                onChange={(nextActive) => onToggleActive(conn.id, nextActive)}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="px-2 py-1.5">
        {isLoading ? (
          <div className="text-center py-5 text-text-muted">
            <span className="material-symbols-outlined text-[28px] animate-spin">
              progress_activity
            </span>
          </div>
        ) : error ? (
          <div className="text-center py-5">
            <span className="material-symbols-outlined text-[28px] text-red-500">
              error
            </span>
            <p className="mt-1.5 text-xs text-text-muted">{error}</p>
          </div>
        ) : quota?.message ? (
          <div className="text-center py-5">
            <p className="text-xs text-text-muted">{quota.message}</p>
          </div>
        ) : (
          <>
            <QuotaTable
              quotas={visibleQuotas}
              compact
              sortMode="default"
              showSortLabel={
                conn.provider === "codex" && quotaSortMode !== "default"
              }
              onHideQuota={(quotaRow) => onHideQuota(conn.provider, quotaRow)}
            />
            {showTokenDetailsHint && (
              <p className="px-1 py-2 text-[11px] leading-relaxed text-text-muted">
                Token usage is in details.
              </p>
            )}
          </>
        )}
        {quota?.message && !error && !isLoading && (
          <p className="mt-2 px-1 text-[10px] leading-relaxed text-text-muted">
            {quota.message}
          </p>
        )}
        {quota?.raw?.note && !quota?.message && !error && !isLoading && (
          <p className="mt-2 px-1 text-[10px] leading-relaxed text-text-muted">
            {quota.raw.note}
          </p>
        )}
        {hiddenQuotaRows.length > 0 && (
          <div className="mt-2 flex min-w-0 items-center gap-1 border-t border-black/5 pt-2 text-[10px] text-text-muted dark:border-white/5">
            <span className="material-symbols-outlined shrink-0 text-[14px]">
              visibility_off
            </span>
            <span className="shrink-0">Hidden:</span>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap pb-2">
              {hiddenQuotaRows.map((quotaRow) => (
                <button
                  key={getQuotaVisibilityKey(quotaRow)}
                  type="button"
                  onClick={() => onShowQuota(conn.provider, quotaRow)}
                  className="shrink-0 rounded-md border border-black/10 px-1.5 py-0.5 transition-colors hover:bg-black/5 hover:text-text-primary dark:border-white/10 dark:hover:bg-white/5"
                  title="Show this quota row"
                >
                  {quotaRow.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
