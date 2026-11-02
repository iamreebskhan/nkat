/**
 * POST /api/referrals/[id]/verifications — a check of the referral's coverage
 * (Level-1 doc:23): how it was checked, what it said, by whom. Manual until a
 * clearinghouse is chosen (Mark Q3). The checks follow the person onto the
 * chart at admission.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { addInsuranceVerification } from "@/lib/features/referrals/referral.service";
import { VerificationSchema } from "@/lib/features/referrals/referral.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, VerificationSchema);
  if (body instanceof Response) return body;
  try {
    const r = await addInsuranceVerification({
      orgId: session.orgId,
      userId: session.userId,
      subject: { referralId: id },
      payload: body,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
