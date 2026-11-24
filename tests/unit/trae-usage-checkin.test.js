import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { runTraeAutoCheckinTick } from "../../src/shared/services/traeAutoCheckin.js";
import {
  beijingDayKey,
  entitlementQuotas,
  isUsableTraeDeviceId,
  newTraeDeviceId,
  parseEntitlementSnapshot,
  runAccountCheckin,
  getTraeAccountUsage,
} from "../../open-sse/services/traeAccount.js";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const FUTURE = 1_900_000_000;
const LATER = 1_910_000_000;
const PAST = 1_700_000_000;

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => body,
  };
}

function pack({ endpoint, limit, consumed, end }) {
  return {
    display_desc: endpoint === 1 ? "Work" : "通用",
    entitlement_base_info: {
      available_endpoint: endpoint,
      end_time: end,
      quota: { credits_limit: limit },
    },
    usage: { credits_amount: consumed },
  };
}

const SNAPSHOT = {
  usage_summary: { total_amount: 7500, consumed_amount: 5879.63 },
  user_entitlement_pack_list: [
    pack({ endpoint: 0, limit: 200, consumed: 20.37, end: FUTURE }),
    pack({ endpoint: 1, limit: 500, consumed: 100, end: LATER }),
    pack({ endpoint: 0, limit: 50, consumed: 10, end: PAST }),
  ],
};

describe("Trae quota tracker eligibility", () => {
  it("lists all three Trae providers", () => {
    for (const id of ["trae", "trae-global", "trae-enterprise"]) {
      expect(USAGE_SUPPORTED_PROVIDERS).toContain(id);
    }
  });
});

describe("Trae credit snapshot", () => {
  it("treats credits_amount as consumed and splits general from Work", () => {
    const quotas = entitlementQuotas(parseEntitlementSnapshot(SNAPSHOT), NOW);
    expect(quotas.Credits).toMatchObject({ used: 5879.63, total: 7500, recurring: false });
    expect(quotas.General).toMatchObject({ used: 30.37, total: 250, recurring: false });
    expect(quotas.Work).toMatchObject({ used: 100, total: 500, recurring: false });
    expect(quotas.Credits.resetAt).toBe(new Date(FUTURE * 1000).toISOString());
    expect(quotas.Work.resetAt).toBe(new Date(LATER * 1000).toISOString());
  });

  it("reads a data-wrapped entitlement payload", () => {
    const quotas = entitlementQuotas(parseEntitlementSnapshot({ data: SNAPSHOT }), NOW);
    expect(quotas.Credits.total).toBe(7500);
  });

  it("keeps the expiry flag through the quota card parser", () => {
    const rows = parseQuotaData("trae", { quotas: entitlementQuotas(parseEntitlementSnapshot(SNAPSHOT), NOW) });
    const general = rows.find((row) => row.name === "General");
    expect(general.recurring).toBe(false);
    expect(general.used).toBe(30.37);
    expect(rows.map((row) => row.name)).toEqual(["Credits", "General", "Work"]);
  });
});

describe("Trae usage requests", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("loads CN credits and does not send device id 0", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SNAPSHOT))
      .mockResolvedValueOnce(jsonResponse(200, { checked_in: false, enable: true, credits: 150, extra_credits: 50, code: 0 }));

    const usage = await getTraeAccountUsage({
      provider: "trae",
      accessToken: "jwt-1",
      providerSpecificData: { deviceId: "0" },
    });

    expect(usage.quotas.Credits.used).toBe(5879.63);
    expect(usage.note).toBe("Daily check-in is still open (+200).");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const statusCall = fetchMock.mock.calls[1];
    expect(String(statusCall[0])).toContain("/trae/api/v2/ug/checkin_credits/status");
    expect(statusCall[1].headers["x-device-id"]).toBeUndefined();
    expect(statusCall[1].headers.Authorization).toBe("Cloud-IDE-JWT jwt-1");
    expect(JSON.parse(statusCall[1].body)).toEqual({ req_source: 1 });
  });

  it("reports the international plan and skips the credit endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      user_pay_identity: 0,
      user_pay_identity_str: "Free",
      has_package: false,
    }));
    const usage = await getTraeAccountUsage({ provider: "trae-global", accessToken: "jwt-2" });
    expect(usage.plan).toBe("Free");
    expect(usage.message).toContain("International plan: Free.");
    expect(String(fetchMock.mock.calls[0][0])).toContain("growsg-normal.trae.ai/trae/api/v1/pay/ide_user_pay_status");
  });

  it("does not present personal credits as the enterprise tenant balance", async () => {
    const usage = await getTraeAccountUsage({ provider: "trae-enterprise", accessToken: "jwt-3" });
    expect(usage.message).toContain("enterprise console");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Trae daily check-in", () => {
  it("uses the Beijing calendar day", () => {
    expect(beijingDayKey(Date.parse("2026-11-24T15:30:00Z"))).toBe("2026-11-24");
    expect(beijingDayKey(Date.parse("2026-11-24T16:30:00Z"))).toBe("2026-11-25");
  });

  it("keeps one non-zero device id", () => {
    expect(isUsableTraeDeviceId("0")).toBe(false);
    expect(isUsableTraeDeviceId("")).toBe(false);
    const id = newTraeDeviceId();
    expect(id).toMatch(/^[1-9]\d{18}$/);
    expect(isUsableTraeDeviceId(id)).toBe(true);
  });

  it("falls back from req_source 1 to 2 when the first status is crowded", async () => {
    const calls = [];
    const outcome = await runAccountCheckin({
      post: async (kind, body) => {
        calls.push([kind, body.req_source]);
        if (kind === "status" && body.req_source === 1) return { httpStatus: 200, body: { code: 9074, message: "busy" } };
        if (kind === "status") return { httpStatus: 200, body: { code: 0, enable: true, checked_in: false, did_checked_in: false } };
        return { httpStatus: 200, body: { code: 0, message: "success" } };
      },
    });
    expect(outcome.status).toBe("claimed");
    expect(calls).toEqual([["status", 1], ["status", 2], ["claim", 1]]);
  });

  it("stops on the device limit without claiming", async () => {
    const outcome = await runAccountCheckin({
      post: async () => ({ httpStatus: 200, body: { code: 0, checked_in: false, did_checked_in: true, enable: true } }),
    });
    expect(outcome.status).toBe("device-already");
  });

  it("claims the next account after one that already checked in elsewhere", async () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const seen = [];
    const saved = [];
    await runTraeAutoCheckinTick({
      now: () => now,
      getSettings: async () => ({ traeAutoCheckin: { deviceId: "1234567890123456789", day: "2026-11-24" } }),
      updateSettings: async (updates) => { saved.push(updates.traeAutoCheckin); },
      getConnections: async () => [
        { id: "already", provider: "trae", accessToken: "a", isActive: true },
        { id: "next", provider: "trae", accessToken: "b", isActive: true },
        { id: "later", provider: "trae", accessToken: "c", isActive: true },
      ],
      checkin: async (connection) => {
        seen.push(connection.id);
        if (connection.id === "already") return { status: "already" };
        if (connection.id === "next") return { status: "claimed", message: "success" };
        return { status: "claimed" };
      },
    });

    expect(seen).toEqual(["already", "next"]);
    const state = saved.at(-1);
    expect(state.done).toEqual(["already", "next"]);
    expect(state.deviceBlocked).toBe(true);
    expect(state.deviceId).toBe("1234567890123456789");
  });

  it("holds an unauthorized account and still checks in the next one", async () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const seen = [];
    let state;
    await runTraeAutoCheckinTick({
      now: () => now,
      getSettings: async () => ({ traeAutoCheckin: { deviceId: "1234567890123456789", day: "2026-11-24" } }),
      updateSettings: async (updates) => { state = updates.traeAutoCheckin; },
      getConnections: async () => [
        { id: "dead", provider: "trae", accessToken: "a", isActive: true },
        { id: "live", provider: "trae", accessToken: "b", isActive: true },
      ],
      refresh: async (connection) => {
        if (connection.id === "dead") throw new Error("Refresh token invalid or reused. Please re-authorize the connection.");
        return { connection };
      },
      checkin: async (connection) => {
        seen.push(connection.id);
        return { status: "already" };
      },
    });
    expect(seen).toEqual(["live"]);
    expect(state.skip).toEqual(["dead"]);
    expect(state.done).toEqual(["live"]);
    expect(state.deviceBlocked).toBe(false);
  });

  it("waits out a backoff without calling check-in", async () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const checkin = vi.fn();
    await runTraeAutoCheckinTick({
      now: () => now,
      getSettings: async () => ({
        traeAutoCheckin: {
          deviceId: "1234567890123456789",
          day: "2026-11-24",
          retryAt: now + 60_000,
          failures: 1,
        },
      }),
      updateSettings: async () => {},
      getConnections: async () => [{ id: "a", provider: "trae", accessToken: "a", isActive: true }],
      checkin,
    });
    expect(checkin).not.toHaveBeenCalled();
  });
});
