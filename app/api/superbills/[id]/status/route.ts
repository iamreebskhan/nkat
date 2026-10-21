/**
 * POST /api/superbills/[id]/status — the dedicated transition endpoint the
 * PATCH route's doc comment has always pointed at (previously never built,
 * leaving markStatus and the submitted/paid bookkeeping unreachable).
 *
 * Body: { to: SuperbillStatus, paidAmountCents?, overpaymentAcknowledged?,
 *         paidInFull?, documentationOverride? }
 * Legal moves are validated in the service (draft → ready_to_submit →
 * submitted → paid | partially_paid | denied | voided; denied → submitted
 * for refiles). submitted_at / paid_at / paid_amount_cents are stamped by
 * the service per transition.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  SUPERBILL_STATUSES,
  markStatus,
} from "@/lib/features/superbills/superbill.service";
import { DocumentationIncompleteError } from "@/lib/features/visits/documentation-check";

const Body = z
  .object({
    to: z.enum(SUPERBILL_STATUSES),
    // A whole-cents sanity bound only, unrelated to the claim: $1,000,000 is
    // nobody's visit. What the payment is actually held to is the claim's own
    // billed amount, which only the service can see — see markStatus.
    paidAmountCents: z.number().int().min(0).max(100_000_000).optional(),
    /** Submit over a payer documentation gap, with the reason (audit R19). */
    documentationOverride: z.object({ reason: z.string().trim().min(10).max(500) }).optional(),
    /** "Yes, the payer paid more than this claim billed" — see markStatus. */
    overpaymentAcknowledged: z.boolean().optional(),
    /**
     * "This payment covers the whole bill" — what the caller's own confirm
     * told the biller. The caller compared against a figure on a screen, which
     * goes stale, so the service re-checks it against the claim: a short
     * payment recorded as paid in full would close the claim (paid is terminal)
     * with the rest unrecordable. See markStatus.
     */
    paidInFull: z.boolean().optional(),
  })
  .refine(
    (b) => !["paid", "partially_paid"].includes(b.to) || b.paidAmountCents !== undefined,
    { message: "paidAmountCents is required when marking paid or partially_paid." },
  );

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const r = await markStatus({
      orgId: session.orgId,
      id,
      to: body.to,
      paidAmountCents: body.paidAmountCents,
      actorUserId: session.userId,
      documentationOverride: body.documentationOverride,
      overpaymentAcknowledged: body.overpaymentAcknowledged,
      paidInFull: body.paidInFull,
    });
    return ok(r);
  } catch (err) {
    // The one refusal a screen can act on: it offers to submit with a reason.
    // A stable field, so the page never matches on the message's wording.
    if (err instanceof DocumentationIncompleteError) {
      return NextResponse.json(
        { success: false, data: { documentationIncomplete: err.gap }, error: err.message },
        { status: 422 },
      );
    }
    // Central policy: typed domain errors echo (404/402/422), everything
    // else is reported + genericized to 500. markStatus throws
    // ValidationError for illegal transitions, NotFoundError for misses.
    return handleServiceError(err);
  }
}
