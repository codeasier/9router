import { describe, it, expect } from "vitest";
import {
  PERIOD_LABELS,
  policyToFormState,
  formatUtcDateTime,
  formatRemaining,
  formatRefreshAt,
} from "@/app/(dashboard)/dashboard/endpoint/budgetWindow.js";

describe("policyToFormState", () => {
  it("returns empty defaults when there is no policy", () => {
    expect(policyToFormState(null)).toEqual({
      budgets: [],
      maxConcurrent: "",
      breakerMode: "fixed",
      breakerMinutes: "5",
    });
  });

  it("copies existing budgets, concurrency, and breaker", () => {
    const form = policyToFormState({
      budgets: [{ provider: "codex", limitUsd: 5, period: "week" }],
      maxConcurrent: 8,
      breaker: { mode: "period", durationMinutes: 30 },
    });
    expect(form.budgets).toEqual([{ provider: "codex", limitUsd: "5", period: "week" }]);
    expect(form.maxConcurrent).toBe("8");
    expect(form.breakerMode).toBe("period");
    expect(form.breakerMinutes).toBe("30");
  });
});

describe("refresh labels", () => {
  const end = Date.UTC(2026, 8, 7, 0, 0, 0); // 2026-09-07 00:00 UTC

  it("formats UTC stamps and remaining time", () => {
    expect(formatUtcDateTime(end)).toBe("2026-09-07 00:00 UTC");
    expect(formatRemaining(end, end - 8 * 3600_000 - 12 * 60_000)).toBe("8h 12m");
    expect(formatRemaining(end, end - 40_000)).toBe("1m");
    expect(formatRemaining(end, end + 1000)).toBe("now");
    expect(formatRefreshAt(end, end - 3600_000)).toBe("2026-09-07 00:00 UTC (1h)");
  });

  it("maps period ids to daily/weekly/monthly labels", () => {
    expect(PERIOD_LABELS.day).toBe("daily");
    expect(PERIOD_LABELS.week).toBe("weekly");
    expect(PERIOD_LABELS.month).toBe("monthly");
  });
});
