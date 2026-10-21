/** POST /api/denials/[id]/refile — mark refiled. */
import { NextResponse, type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { markRefiled } from "@/lib/features/denials/denial.service";
import { RefileSchema } from "@/lib/features/denials/denial.types";
import { DocumentationIncompleteError } from "@/lib/features/visits/documentation-check";

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
      // Named on the activity trail, so the refile history says who sent it.
      actorUserId: session.userId,
      documentationOverride: body.documentationOverride,
    });
    return ok({ ok: true });
  } catch (err) {
    // Refiling sends the claim out, so the payer's documentation standard
    // applies (audit R19); the screen offers to refile with a reason.
    if (err instanceof DocumentationIncompleteError) {
      return NextResponse.json(
        { success: false, data: { documentationIncomplete: err.gap }, error: err.message },
        { status: 422 },
      );
    }
    return handleServiceError(err);
  }
}
