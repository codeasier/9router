import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] }));

const adapter = {
  get() { return undefined; },
  all() { return []; },
  transaction(fn) { return fn(); },
  run(sql, params = []) {
    if (sql.includes("INSERT INTO usageHistory")) {
      state.rows.push({
        timestamp: params[0],
        provider: params[1],
        model: params[2],
        cost: params[8],
        meta: params[11],
      });
    }
  },
};

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => adapter,
}));

import { saveRequestUsage } from "@/lib/db/repos/usageRepo.js";

describe("saveRequestUsage explicit fixed costs", () => {
  beforeEach(() => {
    state.rows.length = 0;
  });

  it("prefers costUsd and preserves distinct zero-token requestIds in meta", async () => {
    const timestamp = "2026-08-30T12:00:00.000Z";
    const base = {
      timestamp,
      provider: "tavily",
      model: "search",
      connectionId: "connection-1",
      apiKey: "client-key",
      endpoint: "/v1/search",
      tokens: {},
      costUsd: 0.008,
      status: "success",
    };

    await expect(saveRequestUsage({ ...base, requestId: "search-request-1" })).resolves.toBe(true);
    await expect(saveRequestUsage({ ...base, requestId: "search-request-2" })).resolves.toBe(true);

    expect(state.rows).toHaveLength(2);
    expect(state.rows.map((row) => row.cost)).toEqual([0.008, 0.008]);
    expect(state.rows.map((row) => JSON.parse(row.meta).requestId)).toEqual([
      "search-request-1",
      "search-request-2",
    ]);
  });
});
