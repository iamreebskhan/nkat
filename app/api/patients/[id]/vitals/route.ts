/**
 * A patient's vitals over time — one capped page of them, newest first, and
 * how many readings exist in all so the screen can say which it is showing.
 *
 * This is the half of Mark's ask that a field on the note could never satisfy:
 * [06:29] "you're going to collect their vitals, KEEP TRACK of their vitals,
 * their weight, all of those things." Weight loss over months is the palliative
 * signal; the Perfect Note records it as prose ("weight loss from 160 pounds to
 * a current 128 pounds"), which is unqueryable. Here it is a series.
 */
import { type NextRequest } from "next/server";

import { fail, ok, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVitalsTrend } from "@/lib/features/visits/note.service";
import { VIEW_ANY_VISIT } from "@/lib/features/visits/visit-access";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * visits.view.own used to be in this list and is not any more.
 *
 * The resource here is a patient's chart, not a visit, so the per-visit
 * ownership rule in visit-access.ts has nothing to bind to: the trend is drawn
 * from the patient's visits whoever conducted them — routinely several
 * clinicians — and filtering it to the caller's own visits would draw a weight
 * curve with silent gaps in it — the one thing this screen exists to get
 * right. So the question is only whether visits.view.own should open a patient
 * chart at all, and it should not: GET /api/patients/[id] requires
 * patients.view flat, and a caller who cannot open the patient record has no
 * business reading that patient's clinical readings by id.
 *
 * Costs no shipped role anything — clinician, billing_agent, read_only and
 * org_admin all carry patients.view, and this trend only ever renders inside
 * the patient chart, which is already behind it.
 */
const READ_ANY = ["patients.view", VIEW_ANY_VISIT];

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  try {
    // 200, not the service's default of 50, and not a widened clamp: 200 is
    // the ceiling getVitalsTrend already enforces, so this asks for the most
    // it will ever give.
    //
    // A patient seen weekly for 14 months has ~60 visits with vitals. At 50,
    // newest-first, the ten that fall off the end are the OLDEST — and those
    // carry the baseline the whole screen is measured FROM: the "160 pounds"
    // in "weight loss from 160 pounds to a current 128 pounds". Labelling the
    // page "Latest 50 of 61" made the truncation honest; it did not put the
    // 160 back on screen. This does.
    const { rows, total } = await getVitalsTrend({
      orgId: session.orgId,
      patientId: id,
      limit: 200,
    });
    // Clinical readings for a named patient are PHI, and this route returns a
    // history of them — the access log matters more here than on a single visit.
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "view",
      context: "vitals_trend",
      request: req,
    });
    // `total` is every visit with vitals for this patient; `trend` is the page
    // the service capped. The screen needs both to say which it is showing —
    // the oldest readings are the baseline the weight loss above is measured
    // from, and dropping them silently is the thing this route exists to avoid.
    return ok({ trend: rows, total });
  } catch (err) {
    return handleServiceError(err);
  }
}
