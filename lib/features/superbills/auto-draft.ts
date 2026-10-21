/**
 * Raise the draft superbill when a visit is signed — and say so when it can't.
 *
 * Moving a visit to pending_billing drafts its bill, so the details reach
 * billing without anyone pulling the visit back by hand (walkthrough [03:18]).
 * That draft is best-effort on purpose: losing an attested sign-off because
 * billing prep failed would be the worse outcome.
 *
 * What was wrong was the silence. The failure went to error tracking and
 * nowhere else: the route returned superbillId: null, and the document page
 * ignored it and showed "Submitted" either way. The clinician walked away
 * believing the visit was on its way to billing when no bill existed.
 *
 * This returns the outcome instead of swallowing it, with a reason written for
 * the person at the screen. Service errors already carry messages written for
 * users; anything else is summarised, because a constraint name or a driver
 * error is not something a clinician can act on.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { reportError } from "@/lib/observability/sentry";

import { buildDraftFromVisit, getSuperbillByVisit, persistDraft } from "./superbill.service";

export type AutoDraftResult =
  | { superbillId: string; reason: null }
  | { superbillId: null; reason: string };

/** Shown when the failure is not one of our own user-facing errors. */
export const AUTO_DRAFT_GENERIC_REASON =
  "The draft bill could not be prepared automatically.";

export async function autoDraftSuperbill(args: {
  orgId: string;
  visitId: string;
  actorUserId?: string;
}): Promise<AutoDraftResult> {
  try {
    // Billed from the billing side while it sat signed: that bill stands, and
    // nothing is drafted over it. Drafting it again wrote the visit's codes
    // back over whatever billing had done since (see persistDraft).
    const existing = await getSuperbillByVisit({ orgId: args.orgId, visitId: args.visitId });
    if (existing) return { superbillId: existing.id, reason: null };

    const draft = await buildDraftFromVisit({ orgId: args.orgId, visitId: args.visitId });
    const saved = await persistDraft({
      orgId: args.orgId,
      draft,
      actorUserId: args.actorUserId,
    });
    return { superbillId: saved.id, reason: null };
  } catch (err) {
    // Still reported — error tracking is where someone fixes the cause. The
    // change is that it is no longer the ONLY place the failure goes.
    reportError(err, { source: "transition:autoDraftSuperbill" });
    const reason =
      err instanceof ValidationError || err instanceof NotFoundError
        ? err.message
        : AUTO_DRAFT_GENERIC_REASON;
    return { superbillId: null, reason };
  }
}
