/**
 * Writing to the audit trail.
 *
 * WHY THIS EXISTS. A live walkthrough of production created a patient, signed
 * a visit and generated a superbill, then read the audit log back: 56 rows,
 * every one of them 'login'. Nothing that touched patient data was recorded
 * anywhere. HIPAA §164.312(b) asks for records of activity in systems holding
 * ePHI, and "who opened this chart, and who changed it" is the first question
 * asked after any incident — it cannot be reconstructed later from tables that
 * only keep the current value.
 *
 * The audit service next door only READS. There was no shared writer, so the
 * two places that did log rolled their own INSERT, and everywhere else simply
 * did not. That is the gap this closes.
 *
 * IN THE CALLER'S TRANSACTION, ON PURPOSE. Every writer here takes the `tx`
 * the action itself is using, so the audit row commits with the action or not
 * at all. A trail that can silently lose entries while the write it describes
 * succeeds is worse than no trail, because it looks complete. The one
 * exception is recordAuditDetached, for callers that have no transaction to
 * join (login, which must not fail because logging did).
 *
 * NO PHI IN THE PAYLOAD. Rows carry ids and field NAMES, never values — no
 * patient name, address, member id or note text. The payload says which
 * fields changed; the record itself says what they changed to, and that is
 * already access-controlled. An audit log that copies PHI just doubles the
 * amount of PHI to protect, and this one is readable by every org admin.
 */
import type { Prisma } from "@prisma/client";

import { withOrgContext } from "@/lib/db";

/**
 * Actions worth a row. Kept as a union so a typo cannot invent an action.
 *
 * READS ARE NOT IN HERE, DELIBERATELY. Opening a chart is already recorded by
 * logPhiAccess() into phi_access_log, a purpose-built table with its own
 * retention and its own §164.528 accounting. I briefly added a 'patient_view'
 * member here before finding that, which would have grown a second, competing
 * read log alongside the working one. Reads go to phi_access_log; this table
 * is for changes and for events an org admin reads day to day.
 */
export type AuditAction =
  | "login"
  | "patient_create"
  | "patient_update"
  | "patient_export"
  | "visit_document"
  | "visit_sign"
  | "visit_reschedule"
  | "superbill_create"
  | "superbill_status_change"
  | "superbill_code_override"
  | "denial_decision"
  | "rulebook_finalize";

export type AuditTargetType =
  | "patient"
  | "visit"
  | "superbill"
  | "denial"
  | "rulebook"
  | "session";

export interface AuditEntry {
  orgId: string;
  userId: string | null;
  action: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string | null;
  /** Ids, field names, counts. Never PHI values. */
  payload?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Write one audit row inside a transaction that is already open. Throws if the
 * insert fails, which will roll the caller's work back with it — deliberate:
 * if we cannot say a chart was changed, we do not change it.
 */
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_log (
      org_id, user_id, action, target_type, target_id, payload, ip_address, user_agent
    ) VALUES (
      ${e.orgId}::uuid,
      ${e.userId ?? null}::uuid,
      ${e.action},
      ${e.targetType ?? null},
      ${e.targetId ?? null}::uuid,
      ${JSON.stringify(e.payload ?? {})}::jsonb,
      ${e.ipAddress ?? null}::inet,
      ${e.userAgent ?? null}
    )
  `;
}

/**
 * For callers with no transaction to join. Opens its own org context and
 * swallows failures, so a logging hiccup cannot 5xx the user — the trade the
 * login path already made deliberately.
 */
export async function recordAuditDetached(e: AuditEntry): Promise<void> {
  try {
    await withOrgContext(e.orgId, async (tx) => writeAudit(tx, e));
  } catch {
    /* best effort by design — see the note above */
  }
}

/**
 * The names of the fields a patch actually changes, for the payload. Values
 * are dropped on the floor; only the keys travel.
 */
export function changedFieldNames(patch: Record<string, unknown>): string[] {
  return Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort();
}
