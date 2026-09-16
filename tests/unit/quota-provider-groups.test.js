import { describe, expect, it } from "vitest";
import {
  filterQuotasForCard,
  getGroupLowestRemaining,
  getHiddenQuotaRows,
  groupConnectionsByProvider,
  isProviderGroupCollapsed,
  isTokenUsageQuotaRow,
  parseQuotaData,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("quota token rows stay off the card", () => {
  it("treats budgetKind tokens as details-only", () => {
    const rows = parseQuotaData("volceapi", {
      quotas: {
        "Credits (today)": { used: 11, total: 150, remainingPercentage: 93, budgetKind: "local-cap" },
        "Tokens (today)": { used: 16544347, total: 0, unlimited: true, budgetKind: "tokens" },
      },
    });
    expect(rows.filter(isTokenUsageQuotaRow).map((row) => row.name)).toEqual(["Tokens (today)"]);
    expect(filterQuotasForCard("volceapi", rows).map((row) => row.name)).toEqual(["Credits (today)"]);
    expect(getHiddenQuotaRows("volceapi", rows, {
      volceapi: { hidden: ["Tokens (today)"] },
    })).toEqual([]);
  });
});

describe("quota provider groups", () => {
  const connections = [
    { id: "a", provider: "claude" },
    { id: "b", provider: "volceapi" },
    { id: "c", provider: "claude" },
    { id: "d", provider: "codex" },
  ];

  it("keeps first-seen provider order and original order within a group", () => {
    expect(groupConnectionsByProvider(connections).map((group) => ({
      provider: group.provider,
      ids: group.connections.map((conn) => conn.id),
    }))).toEqual([
      { provider: "claude", ids: ["a", "c"] },
      { provider: "volceapi", ids: ["b"] },
      { provider: "codex", ids: ["d"] },
    ]);
  });

  it("defaults groups to collapsed until a provider is explicitly expanded", () => {
    expect(isProviderGroupCollapsed("claude", {})).toBe(true);
    expect(isProviderGroupCollapsed("claude", { claude: false })).toBe(false);
    expect(isProviderGroupCollapsed("volceapi", { claude: false })).toBe(true);
    expect(isProviderGroupCollapsed("claude", {}, { onlyGroup: true })).toBe(false);
    expect(isProviderGroupCollapsed("claude", { claude: true }, { onlyGroup: true })).toBe(true);
  });

  it("summarizes the lowest remaining credit in a group and ignores token rows", () => {
    const lowest = getGroupLowestRemaining(
      [{ id: "a", provider: "volceapi" }, { id: "b", provider: "volceapi" }],
      {
        a: { quotas: [
          { name: "Credits (today)", remainingPercentage: 40, budgetKind: "local-cap" },
          { name: "Tokens (today)", used: 9, unlimited: true, budgetKind: "tokens" },
        ] },
        b: { quotas: [{ name: "Credits (today)", remainingPercentage: 12, budgetKind: "local-cap" }] },
      },
    );
    expect(lowest).toBe(12);
  });
});
