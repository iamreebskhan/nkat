/**
 * POST /api/visits/[id]/transition
 *
 * Move the visit through its status lifecycle. Allowed transitions
 * are enforced by `canTransition()` in lib/features/visits/visit-pure.
 * Illegal moves return 422.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { transitionVisit } from "@/lib/features/visits/visit.service";
import { VISIT_STATUSES } from "@/lib/features/visits/visit.types";

interface Params {
  params: Promise<{ id: string }>;
}

const Schema = z.object({
  to: z.enum(VISIT_STATUSES),
});

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.submit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const r = await transitionVisit({
      orgId: session.orgId,
      id,
      to: body.to,
      signedByUserId: session.userId,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
