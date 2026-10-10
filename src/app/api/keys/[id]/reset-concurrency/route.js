import { NextResponse } from "next/server";
import { isManagementAuthenticated } from "@/dashboardGuard";
import { getApiKeyById } from "@/lib/db/index.js";
import { resetKeyConcurrency } from "@/sse/services/keyPolicy.js";

export const dynamic = "force-dynamic";

// POST /api/keys/[id]/reset-concurrency - Explicit emergency slot cleanup.
// Process-local only: not broadcast to other instances, and does not cancel
// real requests. Separate from policy saves and breaker/budget-cache resets.
export async function POST(request, { params }) {
  try {
    // Route-level enforcement is intentional: the ordinary dashboard guard
    // permits anonymous access when requireLogin=false, which is not sufficient.
    if (!(await isManagementAuthenticated(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const clearedSlots = resetKeyConcurrency(key.key);
    return NextResponse.json({
      ok: true,
      clearedSlots,
      scope: "process",
      requestsCancelled: false,
    });
  } catch {
    // Do not log key records or exception messages that could contain secrets.
    console.error("Error resetting key concurrency");
    return NextResponse.json({ error: "Failed to reset key concurrency" }, { status: 500 });
  }
}
