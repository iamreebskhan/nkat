/**
 * GET /api/billing/billable-visits?patientId= — the visits a bill can be
 * raised against for one patient. Powers the Create Bill appointment
 * dropdown (walkthrough 04:03).
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, isUuid, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listBillableVisits } from "@/lib/features/billing/billing-overview.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;

  const patientId = new URL(req.url).searchParams.get("patientId") ?? "";
  if (!isUuid(patientId)) {
    return fail("A valid patientId is required.", { status: 400 });
  }
  try {
    const rows = await listBillableVisits({ orgId: session.orgId, patientId });
    return ok({ rows, total: rows.length });
  } catch (err) {
    return handleServiceError(err);
  }
}
