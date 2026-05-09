/**
 * Platform admin — cross-tenant org listing.
 *
 * Reads with `withBreakglass` (RLS-bypass) so platform_admins see every
 * org. Every call is audit-logged via the `reason` argument.
 */
import { withBreakglass } from "@/lib/db";

export interface AdminOrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  patientCount: number;
  visitCount: number;
  superbillCount: number;
  denialCount: number;
}

export async function listAllOrgs(reason: string): Promise<AdminOrgRow[]> {
  return withBreakglass(async (client) => {
    const rows = await client.$queryRaw<
      {
        id: string;
        name: string;
        slug: string;
        created_at: Date;
        member_count: bigint;
        patient_count: bigint;
        visit_count: bigint;
        superbill_count: bigint;
        denial_count: bigint;
      }[]
    >`
      SELECT
        o.id, o.name, o.slug, o.created_at,
        (SELECT COUNT(DISTINCT user_id) FROM user_permission WHERE org_id = o.id AND user_id IS NOT NULL) AS member_count,
        (SELECT COUNT(*) FROM patient WHERE org_id = o.id) AS patient_count,
        (SELECT COUNT(*) FROM visit WHERE org_id = o.id) AS visit_count,
        (SELECT COUNT(*) FROM superbill WHERE org_id = o.id) AS superbill_count,
        (SELECT COUNT(*) FROM superbill_denial WHERE org_id = o.id) AS denial_count
      FROM org o
      ORDER BY o.created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      createdAt: r.created_at.toISOString(),
      memberCount: Number(r.member_count),
      patientCount: Number(r.patient_count),
      visitCount: Number(r.visit_count),
      superbillCount: Number(r.superbill_count),
      denialCount: Number(r.denial_count),
    }));
  }, reason);
}
