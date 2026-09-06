import { describe, it, expect } from "vitest";
import {
  PERIOD_LABELS,
  PERIOD_ALL_LABELS,
  policyToFormState,
  periodWindowMs,
  formatUtcDateTime,
  formatUtcDate,
  formatUtcDateRange,
  formatPeriodWindow,
  formatRemaining,
  formatRefreshAt,
  previousMonthOverlapUtc,
  buildSpendHierarchy,
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
    expect(PERIOD_ALL_LABELS.week).toBe("week (all)");
  });
});

describe("period windows and spend hierarchy", () => {
  const now = Date.UTC(2026, 8, 6, 15, 50, 0); // Sunday 2026-09-06
  const weekStart = Date.UTC(2026, 7, 31);
  const weekEnd = Date.UTC(2026, 8, 7);
  const monthStart = Date.UTC(2026, 8, 1);
  const monthEnd = Date.UTC(2026, 9, 1);
  const dayStart = Date.UTC(2026, 8, 6);
  const dayEnd = Date.UTC(2026, 8, 7);

  it("uses UTC day / ISO-week Monday / month-1st windows", () => {
    expect(periodWindowMs("day", now)).toEqual([dayStart, dayEnd]);
    expect(periodWindowMs("week", now)).toEqual([weekStart, weekEnd]);
    expect(periodWindowMs("month", now)).toEqual([monthStart, monthEnd]);
  });

  it("formats date ranges and previous-month overlap", () => {
    expect(formatUtcDate(weekStart)).toBe("2026-08-31");
    expect(formatUtcDateRange(weekStart, weekEnd, now)).toBe("2026-08-31 – 2026-09-07 UTC (8h 10m)");
    expect(formatPeriodWindow("day", dayStart, dayEnd, now)).toBe("2026-09-06 UTC (8h 10m)");
    expect(formatPeriodWindow("week", weekStart, weekEnd, now)).toBe("2026-08-31 – 2026-09-07 UTC (8h 10m)");
    expect(previousMonthOverlapUtc(weekStart, monthStart)).toBe("2026-08-31");
    expect(previousMonthOverlapUtc(Date.UTC(2026, 5, 29), Date.UTC(2026, 6, 1))).toBe("2026-06-29 – 2026-06-30");
    expect(previousMonthOverlapUtc(weekEnd, monthStart)).toBeNull();
  });

  it("nests scoped budgets under the matching period and shows leftover as other", () => {
    const rows = buildSpendHierarchy({
      usage: { day: 42.25, week: 376.32, month: 286.9 },
      usageStartMs: { day: dayStart, week: weekStart, month: monthStart },
      usageResetMs: { day: dayEnd, week: weekEnd, month: monthEnd },
      budgets: [{ provider: "codex", period: "week", limitUsd: 400, spentUsd: 263.92 }],
    }, now);

    expect(rows.map((r) => r.period)).toEqual(["day", "week", "month"]);
    const week = rows.find((r) => r.period === "week");
    expect(week.totalUsd).toBe(376.32);
    expect(week.otherUsd).toBeCloseTo(112.4, 5);
    expect(week.prevMonthOverlap).toBe("2026-08-31");
    expect(week.rules).toHaveLength(1);
    expect(rows.find((r) => r.period === "day").otherUsd).toBeNull();
    expect(rows.find((r) => r.period === "month").otherUsd).toBeNull();
  });

  it("omits other-providers when a wildcard budget exists for that period", () => {
    const rows = buildSpendHierarchy({
      usage: { day: 10, week: 100, month: 80 },
      budgets: [
        { provider: "codex", period: "week", limitUsd: 80, spentUsd: 60 },
        { provider: "*", period: "week", limitUsd: 120, spentUsd: 100 },
      ],
    }, now);
    expect(rows.find((r) => r.period === "week").otherUsd).toBeNull();
  });

  it("omits leftover when it is only rounding dust", () => {
    const rows = buildSpendHierarchy({
      usage: { day: 0, week: 10.001, month: 0 },
      budgets: [{ provider: "codex", period: "week", limitUsd: 20, spentUsd: 10 }],
    }, now);
    expect(rows.find((r) => r.period === "week").otherUsd).toBeNull();
  });
});
