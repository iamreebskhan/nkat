/** POST /api/denials/[id]/refile — mark refiled. */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { markRefiled } from "@/lib/features/denials/denial.service";
import { RefileSchema } from "@/lib/features/denials/denial.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.denials.refile"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, RefileSchema);
  if (body instanceof Response) return body;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    await markRefiled({
      orgId: session.orgId,
      id,
      refiledAt: body.refiledAt,
      notes: body.notes,
    });
    return ok({ ok: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
