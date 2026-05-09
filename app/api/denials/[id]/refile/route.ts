/** POST /api/denials/[id]/refile — mark refiled. */
import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
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
  try {
    await markRefiled({
      orgId: session.orgId,
      id,
      refiledAt: body.refiledAt,
      notes: body.notes,
    });
    return ok({ ok: true });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Refile failed", {
      status: 422,
    });
  }
}
