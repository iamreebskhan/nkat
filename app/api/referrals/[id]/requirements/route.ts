/**
 * PUT /api/referrals/[id]/requirements — the pending-requirements checklist
 * (Level-1 doc:25; Mark Q11d default: an editable list, starting empty),
 * replaced whole. Ticking stamps who and when.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { setReferralRequirements } from "@/lib/features/referrals/referral.service";
import { RequirementsSchema } from "@/lib/features/referrals/referral.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.create"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, RequirementsSchema);
  if (body instanceof Response) return body;
  try {
    const requirements = await setReferralRequirements({
      orgId: session.orgId,
      userId: session.userId,
      id,
      items: body.requirements,
    });
    return ok({ requirements });
  } catch (err) {
    return handleServiceError(err);
  }
}
