/** POST /api/denials/[id]/outcome — record paid / partial / secondary-denial / written-off. */
import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { recordOutcome } from "@/lib/features/denials/denial.service";
import { RecordOutcomeSchema } from "@/lib/features/denials/denial.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  // Payment recorded by either the refile-permission user or a
  // designated outcome-tracker. Mapped to refile permission here for
  // simplicity; teams can split it via custom permissions later.
  const session = await requireAuth(["billing.denials.refile"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, RecordOutcomeSchema);
  if (body instanceof Response) return body;
  const { id } = await ctx.params;
  try {
    await recordOutcome({
      orgId: session.orgId,
      id,
      outcome: body.outcome,
      amountCents: body.outcomeAmountCents,
      notes: body.notes,
    });
    return ok({ ok: true });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Outcome failed", {
      status: 422,
    });
  }
}
