/**
 * POST /api/visits/[id]/transition
 *
 * Move the visit through its status lifecycle. Allowed transitions
 * are enforced by `canTransition()` in lib/features/visits/visit-pure.
 * Illegal moves return 422.
 *
 * Moving to `pending_billing` also raises the draft bill — see below.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { transitionVisit } from "@/lib/features/visits/visit.service";
import { autoDraftSuperbill } from "@/lib/features/superbills/auto-draft";
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

    // Client walkthrough [03:18]–[03:22]: "Sign plus Submit for Billing — jab
    // hum log karein to us ki saari details humare paas billing wale mein aa
    // jayein." The transition alone only flipped visit.status, and every query
    // behind /billing reads the superbill table — so pressing the button left
    // the billing dashboard byte-identical and a billing agent had to go pull
    // the visit back by hand. Raise the draft here so the details actually
    // arrive.
    //
    // Outside transitionVisit's transaction on purpose: it holds its own
    // withOrgContext, and buildDraftFromVisit opens another. persistDraft is
    // idempotent on visit_id, so a later Create Bill opens this same row.
    //
    // Best-effort: the visit signs even if the draft fails, because losing an
    // attested sign-off to a billing-prep failure would be the worse outcome.
    // But the outcome is RETURNED now — autoDraftError carries a reason the
    // clinician can read — rather than going to error tracking alone, where
    // it left the screen saying "Submitted" over a visit with no bill.
    let superbillId: string | null = null;
    let autoDraftError: string | null = null;
    // A "Not billed" visit type never gets here: transitionVisit refuses
    // pending_billing for it (audit R18), so no draft is attempted.
    if (body.to === "pending_billing") {
      const draft = await autoDraftSuperbill({
        orgId: session.orgId,
        visitId: id,
        actorUserId: session.userId,
      });
      superbillId = draft.superbillId;
      autoDraftError = draft.reason;
    }

    return ok({ ...r, superbillId, autoDraftError });
  } catch (err) {
    return handleServiceError(err);
  }
}
