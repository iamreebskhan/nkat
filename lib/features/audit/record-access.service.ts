/**
 * Who opened or exported a patient's record — read back for the practice.
 *
 * Every open of a chart is written to phi_access_log by logPhiAccess(), and
 * every export that leaves the platform to phi_export_log by logPhiExport()
 * (0033). Both are retained six years and guarded against deletion, and the
 * audit page's safeguards check says so — but nothing read either table back.
 * A practice asked "who looked at my record?" (HIPAA §164.312(b): record AND
 * examine activity) had no answer short of Pallio querying the database for
 * them. This is the examine half: one timeline over both logs, newest first,
 * for a patient, a person or a date range.
 *
 * ONE ROW PER EXPORT. The three export routes write the download to both
 * logs: phi_export_log from the service, and phi_access_log as an 'export'
 * whose context is the export type. Both rows in the timeline read as two
 * downloads, so the export log's row is shown only when the access log has
 * no such row beside it — an export from before the routes logged access,
 * which on localhost was six of the eight patient-record PDFs.
 *
 * Read under the org's RLS context and named by org as well, like every read
 * here. Viewing this list is not itself logged per patient: it is an org
 * admin's audit duty (audit.view), the same as reading the audit log.
 */
import { withOrgContext } from "@/lib/db";

/**
 * Where the next page starts: the last row's time to the microsecond, and its
 * key. A cursor of the time alone, cut to milliseconds by toISOString, skips
 * any row sharing that millisecond with the end of a page, and one screen
 * opened writes several access rows at nearly the same instant.
 */
export const RECORD_ACCESS_CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|((?:access|export):[0-9a-f-]{36}:(?:[0-9a-f-]{36})?)$/;

export interface RecordAccessRow {
  id: string;
  /** 'access' from phi_access_log, 'export' from phi_export_log. */
  kind: "access" | "export";
  occurredAt: string;
  userEmail: string | null;
  patientId: string | null;
  patientName: string | null;
  /** access_type ('view', 'edit', 'export', 'print', 'api_read') or export_type. */
  what: string;
  /** Where in the app (access context) or what was exported (target). */
  context: string | null;
  ipAddress: string | null;
}

export interface ListRecordAccessArgs {
  orgId: string;
  patientId?: string;
  /** Email (exact match). */
  userEmail?: string;
  fromDate?: Date;
  toDate?: Date;
  /** The previous page's nextCursor, as RECORD_ACCESS_CURSOR matches it. */
  cursor?: string;
  limit?: number;
}

export async function listRecordAccess(args: ListRecordAccessArgs): Promise<{
  rows: RecordAccessRow[];
  nextCursor: string | null;
}> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 100));
  const after = args.cursor ? RECORD_ACCESS_CURSOR.exec(args.cursor) : null;
  if (args.cursor && !after) throw new Error("listRecordAccess: malformed cursor");
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        kind: "access" | "export";
        occurred_at: Date;
        at_micros: string;
        row_key: string;
        user_email: string | null;
        patient_id: string | null;
        patient_name: string | null;
        what: string;
        context: string | null;
        ip_address: string | null;
      }[]
    >`
      SELECT r.*,
             to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_micros
        FROM (
        SELECT a.id, 'access' AS kind, a.occurred_at, u.email::text AS user_email,
               a.patient_id,
               NULLIF(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), '') AS patient_name,
               a.access_type AS what, a.context, a.ip_address::text AS ip_address,
               'access:' || a.id::text || ':' AS row_key
          FROM phi_access_log a
          LEFT JOIN app_user u ON u.id = a.user_id
          LEFT JOIN patient p ON p.id = a.patient_id AND p.org_id = a.org_id
         WHERE a.org_id = ${args.orgId}::uuid
        UNION ALL
        -- One row per patient in the export; an export naming none (a report)
        -- is one row with no patient.
        SELECT e.id, 'export' AS kind, e.occurred_at, u.email::text AS user_email,
               pid AS patient_id,
               NULLIF(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), '') AS patient_name,
               e.export_type AS what, e.target_uri AS context, NULL::text AS ip_address,
               'export:' || e.id::text || ':' || COALESCE(pid::text, '') AS row_key
          FROM phi_export_log e
          CROSS JOIN LATERAL unnest(
            CASE WHEN cardinality(e.patient_ids) = 0 THEN ARRAY[NULL::uuid] ELSE e.patient_ids END
          ) AS pid
          LEFT JOIN app_user u ON u.id = e.user_id
          LEFT JOIN patient p ON p.id = pid AND p.org_id = e.org_id
         WHERE e.org_id = ${args.orgId}::uuid
           -- The same download, already in the access log (see the header).
           AND NOT EXISTS (
             SELECT 1 FROM phi_access_log a2
              WHERE a2.org_id = e.org_id
                AND a2.user_id = e.user_id
                AND a2.patient_id = pid
                AND a2.access_type = 'export'
                AND a2.context = e.export_type
                AND a2.occurred_at BETWEEN e.occurred_at - interval '5 minutes'
                                       AND e.occurred_at + interval '5 minutes')
      ) r
      WHERE (${args.patientId ?? null}::uuid IS NULL OR r.patient_id = ${args.patientId ?? null}::uuid)
        AND (${args.userEmail ?? null}::text IS NULL OR r.user_email = ${args.userEmail ?? null}::citext)
        AND (${args.fromDate ?? null}::timestamptz IS NULL OR r.occurred_at >= ${args.fromDate ?? null}::timestamptz)
        AND (${args.toDate ?? null}::timestamptz IS NULL OR r.occurred_at <= ${args.toDate ?? null}::timestamptz)
        AND (${after?.[1] ?? null}::timestamptz IS NULL
             OR (r.occurred_at, r.row_key COLLATE "C")
                  < (${after?.[1] ?? null}::timestamptz, ${after?.[2] ?? null}::text COLLATE "C"))
      ORDER BY r.occurred_at DESC, r.row_key COLLATE "C" DESC
      LIMIT ${limit}
    `;
    const view: RecordAccessRow[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      occurredAt: r.occurred_at.toISOString(),
      userEmail: r.user_email,
      patientId: r.patient_id,
      patientName: r.patient_name,
      what: r.what,
      context: r.context,
      ipAddress: r.ip_address,
    }));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? `${last.at_micros}|${last.row_key}` : null;
    return { rows: view, nextCursor };
  });
}
