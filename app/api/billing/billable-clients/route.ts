/**
 * GET /api/billing/billable-clients — clients with at least one visit a bill
 * can be raised against. Powers the Create Bill client dropdown
 * (walkthrough 03:48: "is mein humare paas client selection add hoga").
 *
 * Separate from /api/patients on purpose: that list defaults to active
 * patients, which excluded discharged and deceased clients whose claims are
 * still being filed.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listBillableClients } from "@/lib/features/billing/billing-overview.service";

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;

  try {
    const rows = await listBillableClients({ orgId: session.orgId });
    return ok({ rows, total: rows.length });
  } catch (err) {
    return handleServiceError(err);
  }
}
