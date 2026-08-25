import { NextResponse } from "next/server";
import { getApiKeyById, updateApiKey } from "@/lib/localDb";
import { normalizePolicy, resetKeyPolicyState } from "@/sse/services/keyPolicy.js";

export const dynamic = "force-dynamic";

// POST /api/keys/bulk/policy - Apply same policy to multiple keys.
// Body: { ids: string[], policy: object|null }
// policy === null clears the policy (no limits).
export async function POST(request) {
  try {
    const body = await request.json();
    const { ids, policy } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "ids array required" }, { status: 400 });
    }
    if (ids.length > 100) {
      return NextResponse.json({ error: "Too many keys (max 100)" }, { status: 400 });
    }
    if (policy === undefined) {
      return NextResponse.json({ error: "policy field required (null to clear)" }, { status: 400 });
    }
    const normalized = normalizePolicy(policy);
    if (policy !== null && !normalized && (policy?.budgets?.length || policy?.maxConcurrent || policy?.breaker)) {
      return NextResponse.json({ error: "Invalid policy: no valid budgets/maxConcurrent entries found" }, { status: 400 });
    }

    const results = [];
    for (const id of ids) {
      const existing = await getApiKeyById(id);
      if (!existing) {
        results.push({ id, ok: false, error: "Key not found" });
        continue;
      }
      const updated = await updateApiKey(id, { policy: normalized });
      if (updated?.key) resetKeyPolicyState(updated.key);
      results.push({ id, ok: true, key: updated });
    }
    return NextResponse.json({ results });
  } catch (error) {
    console.log("Error bulk updating policy:", error);
    return NextResponse.json({ error: "Failed to bulk update policy" }, { status: 500 });
  }
}
