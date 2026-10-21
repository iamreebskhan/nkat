/**
 * "May this session touch this visit?" — asked once, answered the same way by
 * every per-visit route, on the way in and on the way out.
 *
 * app/api/visits/[id]/route.ts has always enforced the rule: a caller who holds
 * visits.view.own but not visits.view.all may open a visit whose
 * clinician_user_id is their own, and no other. Its per-visit siblings — the
 * note, the note preview, the reconciliation, the addenda, carry-forward and
 * the audit packet — all listed visits.view.own as sufficient in their
 * permission constants and then called the service with {orgId, visitId} only.
 * So for a visit belonging to another clinician, GET /api/visits/<id> answered
 * 403 while GET /api/visits/<id>/note-preview returned that visit's whole
 * rendered note.
 *
 * Two calls reached it, and a screen the clinician already loads handed over
 * the id. sectioned-note.tsx fetches GET /api/visits/<my visit>/carry-forward
 * on mount; that answers with the patient's last signed visit id whoever wrote
 * it, because getCarryForwardSource (note.service.ts) filters on patient and
 * status and never on clinician. Put that id into /note-preview and the whole
 * rendered note came back. On the local fixture four of the twenty-one open
 * visits are offered a source belonging to a different clinician, so this was
 * live, not latent. The visits list is not the leak: it
 * forces clinicianUserId = session.userId for a .own caller, and
 * clinician_user_id is never UPDATEd. Carry-forward is, which is exactly why
 * the note, the preview, the reconciliation, the addenda and the packet had to
 * stop trusting the id they are handed.
 */
import { type NextResponse } from "next/server";

import { fail, type ApiResponse } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

/**
 * The only permission that lifts the ownership test.
 *
 * visits.edit and visits.submit deliberately do NOT, and the reason is the same
 * for both: the clinician role template carries them alongside visits.view.own
 * (lib/features/team/team.types.ts), so reading either as a bypass would make
 * this check a no-op for precisely the caller it exists to constrain. They stay
 * in the routes' permission lists as a way IN to the handler — an editor may
 * edit, a signer may attest — but neither widens the set of visits that is
 * about past the caller's own.
 */
export const VIEW_ANY_VISIT = "visits.view.all";

/**
 * The rule itself, with no I/O, so the routes and the spec read one sentence
 * rather than each restating it.
 */
export function mayAccessVisit(args: {
  permissions: string[];
  userId: string;
  clinicianUserId: string;
}): boolean {
  if (args.permissions.includes(VIEW_ANY_VISIT)) return true;
  return args.clinicianUserId === args.userId;
}

interface VisitOwnerRow {
  clinician_user_id: string;
}

/**
 * Route guard, shaped like requireUuidParam: returns null when the caller may
 * proceed, or the envelope to return when they may not.
 *
 *   const denied = await requireVisitAccess({ session, visitId: id });
 *   if (denied) return denied;
 *
 * A visit that does not exist for this tenant answers 404 "Visit not found." —
 * the exact wording every other visit read uses, so the response cannot be read
 * as a hint that the row exists in some other org. The lookup names the
 * session's org as well as being filtered by RLS, so another org's visit is not
 * found even on a connection that bypasses RLS; past that, this function only
 * decides between clinicians inside one org.
 *
 * It cannot signal refusal by throwing: handleServiceError has no 403 branch,
 * so a thrown denial would be reported as an internal fault and answered 500.
 */
export async function requireVisitAccess(args: {
  session: { orgId: string; userId: string; permissions: string[] };
  visitId: string;
}): Promise<NextResponse<ApiResponse<null>> | null> {
  const rows = await withOrgContext(args.session.orgId, (tx) =>
    tx.$queryRaw<VisitOwnerRow[]>`
      SELECT clinician_user_id FROM visit WHERE id = ${args.visitId}::uuid AND org_id = ${args.session.orgId}::uuid LIMIT 1
    `,
  );
  const owner = rows[0]?.clinician_user_id;
  if (!owner) return fail("Visit not found.", { status: 404 });

  if (
    !mayAccessVisit({
      permissions: args.session.permissions,
      userId: args.session.userId,
      clinicianUserId: owner,
    })
  ) {
    // Byte-for-byte what app/api/visits/[id]/route.ts answers for this exact
    // refusal, pinned by a test that calls both. A second wording would tell
    // one clinician two different things about one visit depending on which
    // URL they arrived through, and the longer wording this replaced also
    // confirmed to a refused caller that the visit exists and whose it is —
    // against the preference lib/api.ts states on NotFoundError.
    return fail("Permission denied", { status: 403 });
  }
  return null;
}
