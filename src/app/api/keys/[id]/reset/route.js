import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { getKeyPolicyStatus, resetKeyPolicyState } from "@/sse/services/keyPolicy.js";

export const dynamic = "force-dynamic";

// POST /api/keys/[id]/reset - Manually reset breaker + budget cache for a key.
// Clears the circuit-breaker cooldown so a raised limit (or manual intervention)
// takes effect immediately without waiting for the next period/cooldown.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    resetKeyPolicyState(key.key);
    const status = await getKeyPolicyStatus(key.key, { skipCache: true });
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    console.log("Error resetting key policy state:", error);
    return NextResponse.json({ error: "Failed to reset key state" }, { status: 500 });
  }
}
