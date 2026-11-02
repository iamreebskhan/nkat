/**
 * GET /api/patients/[id]/alerts — the patient's escalation alerts (0116;
 * Level-1 doc:55-57), newest first; ?status=open for the ones waiting.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseSearchParams, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { ALERT_STATUSES } from "@/lib/features/care-coordination/care-coordination.types";
import { listAlerts } from "@/lib/features/care-coordination/escalation.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

const Query = z.object({ status: z.enum(ALERT_STATUSES).optional() });

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const q = parseSearchParams(new URL(req.url), Query);
  if (q instanceof Response) return q;
  try {
    const rows = await listAlerts({ orgId: session.orgId, patientId: id, status: q.status });
    void logPhiAccess({
      orgId: session.orgId, userId: session.userId, patientId: id, accessType: "view", context: "escalation_alerts", request: req,
    });
    return ok({ rows });
  } catch (err) {
    return handleServiceError(err);
  }
}
