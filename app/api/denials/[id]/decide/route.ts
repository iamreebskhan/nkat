/**
 * POST /api/denials/[id]/decide — record the billing agent's
 * refile / write_off / appeal decision.
 */
import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
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
    return fail(err instanceof Error ? err.message : "Decide failed", {
      status: 422,
    });
  }
}
