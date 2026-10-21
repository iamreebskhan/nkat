/** POST /api/denials/[id]/outcome — record paid / partial / secondary-denial / written-off. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { recordOutcome } from "@/lib/features/denials/denial.service";
import { RecordOutcomeSchema } from "@/lib/features/denials/denial.types";

/**
 * outcomeAmountCents is bounded by what the denial denied, in the service. The
 * flag is how a caller says the payer really did pay more than that — it is
 * sent only after the screen has shown both figures, exactly as the claim
 * queue's overpayment confirmation is.
 */
const OutcomeBody = RecordOutcomeSchema.extend({
  overpaymentAcknowledged: z.boolean().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  // Payment recorded by either the refile-permission user or a
  // designated outcome-tracker. Mapped to refile permission here for
  // simplicity; teams can split it via custom permissions later.
  const session = await requireAuth(["billing.denials.refile"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, OutcomeBody);
  if (body instanceof Response) return body;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    await recordOutcome({
      orgId: session.orgId,
      id,
      outcome: body.outcome,
      amountCents: body.outcomeAmountCents,
      notes: body.notes,
      byUserId: session.userId,
      overpaymentAcknowledged: body.overpaymentAcknowledged,
    });
    return ok({ ok: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
