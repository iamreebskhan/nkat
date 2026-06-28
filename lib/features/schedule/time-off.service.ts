/**
 * PTO / time-off service (Phase E.1d). RLS-scoped.
 */
import { withOrgContext } from "@/lib/db";

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

export async function createTimeOff(args: {
  orgId: string;
  createdBy: string;
  clinicianUserId: string;
  startDate: string;
  endDate: string;
  reason?: string;
}): Promise<{ id: string }> {
  return withOrgContext(args.orgId, async (tx) => {
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

export async function deleteTimeOff(args: {
  orgId: string;
  id: string;
}): Promise<{ deleted: boolean }> {
  return withOrgContext(args.orgId, async (tx) => {
    const n = await tx.$executeRaw`
      DELETE FROM time_off WHERE id = ${args.id}::uuid
    `;
    return { deleted: n > 0 };
  });
}
