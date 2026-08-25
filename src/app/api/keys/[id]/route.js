import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { normalizePolicy, resetKeyPolicyState } from "@/sse/services/keyPolicy.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key (isActive and/or policy)
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, policy } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (policy !== undefined) {
      // null clears the policy; invalid shapes normalize to null (no limits)
      const normalized = normalizePolicy(policy);
      if (policy !== null && !normalized && (policy?.budgets?.length || policy?.maxConcurrent || policy?.breaker)) {
        return NextResponse.json({ error: "Invalid policy: no valid budgets/maxConcurrent entries found" }, { status: 400 });
      }
      updateData.policy = normalized;
    }

    const updated = await updateApiKey(id, updateData);
    if (policy !== undefined && updated?.key) {
      // Clear budget cache + policy cache and any open breakers so a raised
      // limit takes effect immediately (manual reset also uses this).
      resetKeyPolicyState(updated.key);
    }

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
