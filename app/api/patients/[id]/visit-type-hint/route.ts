/**
 * GET /api/patients/[id]/visit-type-hint?at=<ISO>&excludeVisitId=<uuid>
 *
 * What Pallio's own history says about new vs established for this patient on
 * the date `at` (now when absent): the latest visit in this org within the
 * three years before it, whoever the clinician. The scheduler shows it under
 * the Visit type select, and the document screen's Visit type card re-checks
 * it with the visit itself left out.
 *
 * Its own route rather than GET /api/visits?patientId=: that list forces
 * clinicianUserId to the caller for a visits.view.own caller
 * (app/api/visits/route.ts), so a clinician would miss a colleague's visit —
 * and under the CMS same-group rule that visit is exactly what makes the
 * patient established. A hint only: the practice may have seen the patient
 * before it used Pallio, and nothing here can know that.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, handleServiceError, parseSearchParams, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { findPriorVisit } from "@/lib/features/visits/visit.service";
import { VIEW_ANY_VISIT } from "@/lib/features/visits/visit-access";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * The patient chart's own gate, as the vitals trend (app/api/patients/[id]/
 * vitals/route.ts): the answer is drawn from every clinician's visits, so the
 * per-visit ownership rule has nothing to bind to, and a caller who cannot
 * open the patient record has no business reading its visit history.
 */
const READ_ANY = ["patients.view", VIEW_ANY_VISIT];

const HintQuery = z.object({
  at: z.string().datetime({ offset: true }).optional(),
  excludeVisitId: z.string().uuid().optional(),
});

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  const q = parseSearchParams(new URL(req.url), HintQuery);
  if (q instanceof Response) return q;

  try {
    const hint = await findPriorVisit({
      orgId: session.orgId,
      patientId: id,
      before: q.at ? new Date(q.at) : new Date(),
      excludeVisitId: q.excludeVisitId ?? null,
    });
    // The date and status of this patient's last visit is PHI, and this is a
    // read of their visit history: logged every time, as the vitals trend is.
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "view",
      context: "visit_type_hint",
      request: req,
    });
    return ok(hint);
  } catch (err) {
    return handleServiceError(err);
  }
}
