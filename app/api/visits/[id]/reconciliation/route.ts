/**
 * GET /api/visits/[id]/reconciliation — does this note agree with this claim?
 *
 * The half of Mark's audit ask that has to reach the clinician [10:12]:
 * "they're going to want to take the note and they want to take the Superbill
 * and compare them and make sure that they match... that's where a lot of
 * people and a lot of agencies that you work with either cheat, or fall, or
 * break the rules and don't realize it — is because the two are not linked
 * together."
 *
 * "don't realize it" is the operative phrase. The comparison already existed
 * but only inside a PDF, behind a billing-export permission no clinician
 * holds — so the person who could still fix the note was the one person who
 * could not see the problem.
 *
 * Permissions: clinical read only. This returns findings about a visit the
 * caller can already open, hands over no document, and is not a §164.528
 * disclosure. The PDF packet stays gated on billing.superbills.export.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVisitReconciliation } from "@/lib/features/visits/audit-packet.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

const CLINICAL_READ = ["visits.view.all", "visits.view.own", "visits.edit"];

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!CLINICAL_READ.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // Clinical read is the door, not the claim on this row: a .own-only caller
  // still only reconciles their own visits (see visit-access.ts).
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  try {
    return ok(await getVisitReconciliation({ orgId: session.orgId, visitId: id }));
  } catch (err) {
    return handleServiceError(err);
  }
}
