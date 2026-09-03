import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { getKeyPolicyStatus } from "@/sse/services/keyPolicy.js";

// GET /api/keys/status - Live policy status (in-flight, spend, breakers) for all keys.
// Budget reads go through the 30s enforcement cache, so polling is cheap.
export async function GET() {
  try {
    const keys = await getApiKeys();
    const statuses = {};
    for (const key of keys) {
      statuses[key.id] = await getKeyPolicyStatus(key.key);
    }
    return NextResponse.json({ statuses, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.log("Error fetching key statuses:", error);
    return NextResponse.json({ error: "Failed to fetch key statuses" }, { status: 500 });
  }
}
