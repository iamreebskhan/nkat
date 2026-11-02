/**
 * One referral (0111).
 *
 *   GET   — the referral, its triage and its coverage checks
 *   PATCH — correct what was taken down (UpdateReferralSchema, tri-state)
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getReferral, updateReferral } from "@/lib/features/referrals/referral.service";
import { UpdateReferralSchema } from "@/lib/features/referrals/referral.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const referral = await getReferral({ orgId: session.orgId, id });
    if (!referral) return fail("Referral not found.", { status: 404 });
    return ok(referral);
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.create"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, UpdateReferralSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updateReferral({ orgId: session.orgId, userId: session.userId, id, payload: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
