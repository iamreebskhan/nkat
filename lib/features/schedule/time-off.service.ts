/**
 * PTO / time-off service (Phase E.1d). RLS-scoped.
 *
 * WHOSE CALENDAR IS THIS? Both writes here ask that question before they act,
 * and they ask it in this file rather than in the route, because the answer
 * needs the row (DELETE) and because a second caller must not be able to reach
 * the table without it.
 *
 * Before this, DELETE /api/time-off/[id] gated on schedule.edit — which the
 * clinician template carries "so they can move their own visits on the week
 * grid" (lib/features/team/team.types.ts) — and then ran
 * `DELETE FROM time_off WHERE id = $1` on whatever id it was handed. Any of the
 * six schedule.edit holders in the demo org could clear any of the other seven
 * members' approved leave; the day freed up on the grid and no row anywhere
 * said who did it. RLS does not help: pg_policies shows time_off carries one
 * policy, tenant_isolation on org_id, so the tenant boundary holds and nothing
 * inside the org is constrained. POST was the mirror — its membership guard
 * checked that the SUBJECT was an active member but never that the CALLER had
 * any claim on that subject's calendar, so the same clinician could book leave
 * onto a colleague's.
 */
import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit, type AuditAction } from "@/lib/features/audit/audit-write";
// The ownership rule is the visit grid's rule, on purpose: a PTO bar and a
// visit chip are drawn on the same week grid by the same page, and "whose row
// is this, and may I touch it?" has to have ONE answer on that screen.
// mayAccessVisit is pure — (permissions, caller, the row's clinician) — and
// VIEW_ANY_VISIT (visits.view.all) is the only permission that lifts it, which
// is also the permission every org_admin holds and no clinician does in any
// org in this database. Renamed on import because the row here is a time_off
// row, not a visit: the RULE is what is borrowed, and borrowing it means the
// two cannot drift apart.
import { mayAccessVisit as mayActOnClinicianRow } from "@/lib/features/visits/visit-access";

/**
 * Deleting someone's leave is a schedule change an org admin has to be able to
 * ask about afterwards, and the row itself is gone by then.
 *
 * WHY A CAST. AuditAction (lib/features/audit/audit-write.ts) has no time-off
 * member yet and that file is outside this change. audit_log.action is a plain
 * text column with no CHECK constraint — verified by reading pg_constraint on
 * the running database — so the row writes and /api/audit returns it; until
 * summarizeAuditPayload (audit-pure.ts) learns the case, the audit screen
 * prints the action and the target with no detail line. Replace the cast with
 * a real union member when audit-write.ts can be edited.
 */
const TIME_OFF_DELETE: AuditAction = "time_off_delete" as AuditAction;

/**
 * Shown to a clinician who picked a colleague in the Add PTO composer. It is
 * the one refusal on these two routes a person actually reads — the delete has
 * no button anywhere in the UI — so it says what they may do instead rather
 * than only that they may not.
 */
export const PTO_NOT_YOUR_CALENDAR =
  "You can only book time off on your own calendar. An admin who can see the " +
  "whole team's schedule can book it for someone else.";

export interface TimeOffView {
  id: string;
  clinicianUserId: string;
  clinicianName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
}

interface Row {
  id: string;
  clinician_user_id: string;
  clinician_name: string | null;
  start_date: Date;
  end_date: Date;
  reason: string | null;
}

/**
 * Deliberately org-wide, unlike the two writes below. Knowing that a colleague
 * is out is the entire point of a shared week grid — /api/schedule/context
 * draws every member's PTO bar for anyone holding schedule.view — so narrowing
 * this read to the caller's own leave would break the screen it feeds. The
 * boundary this feature needed is on WRITING to someone else's calendar, not
 * on seeing that they are away.
 */
export async function listTimeOff(args: {
  orgId: string;
  fromIso?: string;
  toIso?: string;
}): Promise<TimeOffView[]> {
  const from = args.fromIso ? args.fromIso.slice(0, 10) : null;
  const to = args.toIso ? args.toIso.slice(0, 10) : null;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT t.id, t.clinician_user_id, u.full_name AS clinician_name,
             t.start_date, t.end_date, t.reason
        FROM time_off t
        LEFT JOIN app_user u ON u.id = t.clinician_user_id
       WHERE (${from}::date IS NULL OR t.end_date >= ${from}::date)
         AND (${to}::date IS NULL OR t.start_date <= ${to}::date)
       ORDER BY t.start_date ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      clinicianUserId: r.clinician_user_id,
      clinicianName: r.clinician_name,
      startDate: r.start_date.toISOString().slice(0, 10),
      endDate: r.end_date.toISOString().slice(0, 10),
      reason: r.reason,
    }));
  });
}

/**
 * Either the booking, or the refusal the route turns into a 403.
 *
 * A refusal is a RETURN VALUE and not a throw for the same reason
 * visit-access.ts gives: handleServiceError (lib/api.ts) has no 403 branch, so
 * a thrown denial would be reported as an internal fault and answered 500.
 */
export type CreateTimeOffResult = { id: string } | { id: null; refusedReason: string };

export async function createTimeOff(args: {
  orgId: string;
  createdBy: string;
  /** The CALLER's permissions — what decides whose calendar they may write to. */
  createdByPermissions: string[];
  clinicianUserId: string;
  startDate: string;
  endDate: string;
  reason?: string;
}): Promise<CreateTimeOffResult> {
  // The caller test comes FIRST, before any statement runs. Two reasons: a
  // caller with no claim on this calendar should not learn from a 422 whether
  // the colleague they named is still on the roster, and the membership guard
  // below answers a different question (is the SUBJECT a member) that was
  // mistaken for this one — it bound args.clinicianUserId and never the
  // caller, so a clinician could book leave onto any active colleague.
  if (
    !mayActOnClinicianRow({
      permissions: args.createdByPermissions,
      userId: args.createdBy,
      clinicianUserId: args.clinicianUserId,
    })
  ) {
    return { id: null, refusedReason: PTO_NOT_YOUR_CALENDAR };
  }
  return withOrgContext(args.orgId, async (tx) => {
    // app_user is global, so time_off's FK accepts ANY user id. The Add PTO
    // picker only offers active members, but nothing here checked: a direct
    // POST could block out a removed member's calendar, or a user id from
    // another tenant, which then shows on this org's schedule as a PTO bar
    // under a stranger's name and counts against nobody's availability.
    // One refusal covers both the removed member and the complete stranger:
    // RLS scopes org_member to this org, so we cannot tell "member of another
    // org" from "no such user" — and saying which would leak whether a user
    // id exists elsewhere. The fix is the same either way: use the list.
    // org_id is named as well as relied on through RLS, so the guard holds
    // even if the tenant GUC is ever missed.
    const member = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM org_member
       WHERE org_id = ${args.orgId}::uuid
         AND user_id = ${args.clinicianUserId}::uuid
         AND status = 'active'
       LIMIT 1
    `;
    if (!member[0]) {
      throw new ValidationError(
        `Clinician ${args.clinicianUserId} is not an active member of this organization. Pick someone from the Clinician list.`,
      );
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO time_off (org_id, clinician_user_id, start_date, end_date, reason, created_by)
      VALUES (${args.orgId}::uuid, ${args.clinicianUserId}::uuid,
              ${args.startDate}::date, ${args.endDate}::date,
              ${args.reason ?? null}, ${args.createdBy}::uuid)
      RETURNING id
    `;
    return { id: rows[0]!.id };
  });
}

interface OwnerRow {
  clinician_user_id: string;
  start_date: Date;
  end_date: Date;
  reason: string | null;
}

/**
 * `refusedReason` is present only when the row exists and this caller may not
 * remove it; the route answers 403 with it. `deleted: false` on its own means
 * no such row for this tenant, which the route answers 404.
 */
export type DeleteTimeOffResult = { deleted: boolean; refusedReason?: string };

export async function deleteTimeOff(args: {
  orgId: string;
  id: string;
  /** Who is asking. Their own leave they may remove; anyone else's needs the lift. */
  callerUserId: string;
  callerPermissions: string[];
}): Promise<DeleteTimeOffResult> {
  return withOrgContext(args.orgId, async (tx) => {
    // Read the row before deciding, for two things at once: whose leave this
    // is, and what the audit row has to carry. The audit row is written after
    // the DELETE, when the row it describes no longer exists, so anything the
    // trail needs has to be lifted out here.
    const rows = await tx.$queryRaw<OwnerRow[]>`
      SELECT clinician_user_id, start_date, end_date, reason
        FROM time_off
       WHERE id = ${args.id}::uuid
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { deleted: false };

    if (
      !mayActOnClinicianRow({
        permissions: args.callerPermissions,
        userId: args.callerUserId,
        clinicianUserId: row.clinician_user_id,
      })
    ) {
      // Byte-for-byte what requireVisitAccess answers for the same refusal on
      // the same grid, and deliberately terse: unlike the composer's message,
      // nobody reaches this through a screen — there is no delete button — so
      // the only readers are callers holding an id, who are told nothing about
      // the row beyond the fact that it is not theirs to remove.
      return { deleted: false, refusedReason: "Permission denied" };
    }

    // Matched on id alone: the guard above already decided, in this same
    // transaction, on a column no statement in this codebase ever UPDATEs.
    // Repeating the ownership test in the WHERE clause would be a second lock
    // on the same door with the same key — and, worse, a lock no test could
    // ever prove is there, because removing it would change nothing anyone can
    // observe.
    const n = await tx.$executeRaw`
      DELETE FROM time_off WHERE id = ${args.id}::uuid
    `;
    if (n === 0) return { deleted: false };

    // In the caller's transaction, so the trail cannot lose an entry while the
    // deletion it describes succeeds (audit-write.ts). Ids, dates and flags
    // only: the leave's reason is free text a member typed, and it never
    // travels — /api/audit strips a 'reason' key on the way out anyway.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.callerUserId,
      action: TIME_OFF_DELETE,
      // The PTO row is gone, so the durable target is the person whose
      // calendar changed; timeOffId below keeps the tombstone.
      targetType: "user",
      targetId: row.clinician_user_id,
      payload: {
        timeOffId: args.id,
        clinicianUserId: row.clinician_user_id,
        startDate: row.start_date.toISOString().slice(0, 10),
        endDate: row.end_date.toISOString().slice(0, 10),
        hadReason: row.reason !== null,
        // The question an admin actually asks first: did someone remove
        // another member's leave, or their own? When it is someone else's,
        // VIEW_ANY_VISIT is what let them — nothing else can.
        removedOwnLeave: row.clinician_user_id === args.callerUserId,
      },
    });
    return { deleted: true };
  });
}
