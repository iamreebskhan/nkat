/**
 * POST /api/referrals/[id]/triage — the initial clinical triage (Level-1
 * doc:26-27): symptoms, immediate needs, preliminary acuity, possible hospice
 * eligibility. Done by a nurse or other clinical team member, so it takes
 * patient.acuity.edit, the grant for that judgment, which clinicians hold. Not
 * patients.edit: intake holds that one, to correct demographics and insurance.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { addReferralTriage } from "@/lib/features/referrals/referral.service";
import { TriageSchema } from "@/lib/features/referrals/referral.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patient.acuity.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, TriageSchema);
  if (body instanceof Response) return body;
  try {
    const r = await addReferralTriage({ orgId: session.orgId, userId: session.userId, referralId: id, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
