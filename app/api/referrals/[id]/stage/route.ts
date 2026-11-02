/**
 * POST /api/referrals/[id]/stage — a disposition or a move from the board:
 * not taken under care (with its reason code and day, Level-1 doc:25), set
 * aside as pending long term, transitioned, or reopened. Admission is not
 * here: completing intake for the referral admits it.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { changeReferralStage } from "@/lib/features/referrals/referral.service";
import { StageChangeSchema } from "@/lib/features/referrals/referral.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.create"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, StageChangeSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await changeReferralStage({ orgId: session.orgId, userId: session.userId, id, change: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
