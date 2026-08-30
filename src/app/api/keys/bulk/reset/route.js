import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { getKeyPolicyStatus, resetKeyPolicyState } from "@/sse/services/keyPolicy.js";

export const dynamic = "force-dynamic";

// POST /api/keys/bulk/reset - Reset breaker + budget cache for multiple keys.
// Body: { ids: string[] }
export async function POST(request) {
  try {
    const body = await request.json();
    const { ids } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "ids array required" }, { status: 400 });
    }
    if (ids.length > 100) {
      return NextResponse.json({ error: "Too many keys (max 100)" }, { status: 400 });
    }
    const results = [];
    for (const id of ids) {
      const key = await getApiKeyById(id);
      if (!key) {
        results.push({ id, ok: false, error: "Key not found" });
        continue;
      }
      resetKeyPolicyState(key.key);
      const status = await getKeyPolicyStatus(key.key, { skipCache: true });
      results.push({ id, ok: true, status });
    }
    return NextResponse.json({ results });
  } catch (error) {
    console.log("Error bulk resetting keys:", error);
    return NextResponse.json({ error: "Failed to bulk reset" }, { status: 500 });
  }
}
