/**
 * POST /api/denials/[id]/decide — record the billing agent's
 * refile / write_off / appeal decision.
 */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { decideDenial } from "@/lib/features/denials/denial.service";
import { DecideDenialSchema } from "@/lib/features/denials/denial.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.denials.refile"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, DecideDenialSchema);
  if (body instanceof Response) return body;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    await decideDenial({
      orgId: session.orgId,
      id,
      decision: body.decision,
      byUserId: session.userId,
      notes: body.notes,
    });
    return ok({ ok: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
