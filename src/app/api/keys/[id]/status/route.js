import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { getKeyPolicyStatus } from "@/sse/services/keyPolicy.js";

// GET /api/keys/[id]/status - Live policy status (in-flight, spend, breakers)
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const status = await getKeyPolicyStatus(key.key);
    return NextResponse.json({ status, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.log("Error fetching key status:", error);
    return NextResponse.json({ error: "Failed to fetch key status" }, { status: 500 });
  }
}
