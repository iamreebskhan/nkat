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
import {
  buildDraftFromVisit,
  persistDraft,
} from "@/lib/features/superbills/superbill.service";
import { reportError } from "@/lib/observability/sentry";
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
    // Best-effort: a visit with no codes yet still signs successfully. Losing
    // the sign-off because billing prep failed would be the worse outcome.
    let billId: string | null = null;
    if (body.to === "pending_billing") {
      try {
        const draft = await buildDraftFromVisit({ orgId: session.orgId, visitId: id });
        const saved = await persistDraft({
          orgId: session.orgId,
          draft,
          actorUserId: session.userId,
        });
        billId = saved.id;
      } catch (err) {
        reportError(err, { source: "transition:autoDraftSuperbill" });
      }
    }

    return ok({ ...r, superbillId: billId });
  } catch (err) {
    return handleServiceError(err);
  }
}
