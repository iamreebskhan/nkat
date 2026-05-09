/**
 * Audit log reader — list + filter for org admins.
 *
 * Read-only. The audit table is append-only; the retention trigger
 * (0033) refuses DELETE/UPDATE on rows <6y old.
 *
 * Filterable by user, action, target, time range. Cursor-paginated by
 * occurred_at (descending) so a common query pattern stays cheap.
 */
import { withOrgContext } from "@/lib/db";

export interface AuditLogRow {
  id: string;
  userEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: string;
}

export interface ListAuditArgs {
  orgId: string;
  /** Email (exact match). */
  userEmail?: string;
  /** Action prefix (e.g. 'login', 'consent_grant'). */
  action?: string;
  fromDate?: Date;
  toDate?: Date;
  /** ISO string of the previous page's last occurredAt. */
  cursor?: string;
  limit?: number;
}

export async function listAuditLog(args: ListAuditArgs): Promise<{
  rows: AuditLogRow[];
  nextCursor: string | null;
}> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 100));
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        user_email: string | null;
        action: string;
        target_type: string | null;
        target_id: string | null;
        payload: Record<string, unknown>;
        ip_address: string | null;
        user_agent: string | null;
        occurred_at: Date;
      }[]
    >`
      SELECT a.id, u.email AS user_email, a.action, a.target_type, a.target_id,
             a.payload, a.ip_address::text AS ip_address, a.user_agent, a.occurred_at
      FROM audit_log a
      LEFT JOIN app_user u ON u.id = a.user_id
      WHERE
        (${args.userEmail ?? null}::text IS NULL OR u.email = ${args.userEmail ?? null}::citext)
        AND (${args.action ?? null}::text IS NULL OR a.action LIKE (${args.action ?? null}::text || '%'))
        AND (${args.fromDate ?? null}::timestamptz IS NULL OR a.occurred_at >= ${args.fromDate ?? null}::timestamptz)
        AND (${args.toDate ?? null}::timestamptz IS NULL OR a.occurred_at <= ${args.toDate ?? null}::timestamptz)
        AND (${args.cursor ?? null}::timestamptz IS NULL OR a.occurred_at < ${args.cursor ?? null}::timestamptz)
      ORDER BY a.occurred_at DESC
      LIMIT ${limit}
    `;
    const view: AuditLogRow[] = rows.map((r) => ({
      id: r.id,
      userEmail: r.user_email,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      payload: r.payload,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      occurredAt: r.occurred_at.toISOString(),
    }));
    const nextCursor = view.length === limit ? view[view.length - 1]!.occurredAt : null;
    return { rows: view, nextCursor };
  });
}
