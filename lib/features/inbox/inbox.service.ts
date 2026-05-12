/**
 * Inbox aggregator — work routed to the current user.
 *
 * Pulls three task types into a single time-ordered feed:
 *   - Open visits the user is the clinician for (status = scheduled / in_progress / documented)
 *   - Attestation requests claimed by the user (status = in_progress)
 *   - Denials whose decision is still 'pending' (visible to anyone with billing.denials.view)
 *
 * Each item has a stable `key`, a human label, an `occurredAt` timestamp,
 * and a `href` deep-link. The UI renders them as a single list ordered
 * newest-first.
 */
import { withOrgContext } from "@/lib/db";

export type InboxItemKind = "visit" | "attestation_request" | "denial";

export interface InboxItem {
  key: string;
  kind: InboxItemKind;
  title: string;
  subtitle: string;
  href: string;
  occurredAt: string;
}

export async function listInbox(args: {
  orgId: string;
  userId: string;
  /** True if the user has billing.denials.view — controls denial fetch. */
  canSeeDenials: boolean;
  limit?: number;
}): Promise<InboxItem[]> {
  const limit = Math.min(100, args.limit ?? 50);

  return withOrgContext(args.orgId, async (tx) => {
    const visits = await tx.$queryRaw<
      {
        id: string;
        visit_type: string;
        status: string;
        scheduled_start: Date | null;
        patient_id: string;
        first_name: string | null;
        last_name: string | null;
      }[]
    >`
      SELECT v.id, v.visit_type, v.status, v.scheduled_start,
             v.patient_id, p.first_name, p.last_name
      FROM visit v
      JOIN patient p ON p.id = v.patient_id
      WHERE v.clinician_user_id = ${args.userId}::uuid
        AND v.status IN ('scheduled', 'in_progress', 'documented')
      ORDER BY COALESCE(v.scheduled_start, v.created_at) DESC
      LIMIT ${limit}
    `;

    const requests = await tx.$queryRaw<
      {
        id: string;
        cpt_code: string;
        attribute: string;
        state: string | null;
        claimed_at: Date | null;
      }[]
    >`
      SELECT id, cpt_code, attribute, state, claimed_at
      FROM analyst_attestation_request
      WHERE claimed_by_user_id = ${args.userId}::uuid
        AND status = 'in_progress'
      ORDER BY claimed_at DESC NULLS LAST
      LIMIT ${limit}
    `;

    let denials: {
      id: string;
      cpt_code: string;
      carc_code: string;
      denied_at: Date;
      denied_amount_cents: bigint;
    }[] = [];
    if (args.canSeeDenials) {
      denials = await tx.$queryRaw`
        SELECT id, cpt_code, carc_code, denied_at, denied_amount_cents
        FROM superbill_denial
        WHERE decision = 'pending'
        ORDER BY denied_at DESC
        LIMIT ${limit}
      `;
    }

    const out: InboxItem[] = [];

    for (const v of visits) {
      const patientName = `${v.first_name ?? ""} ${v.last_name ?? ""}`.trim() || "Patient";
      out.push({
        key: `visit:${v.id}`,
        kind: "visit",
        title:
          v.status === "documented"
            ? `Submit ${patientName}'s visit`
            : v.status === "in_progress"
              ? `Resume documenting ${patientName}`
              : `Upcoming visit — ${patientName}`,
        subtitle: `${v.visit_type.replace(/_/g, " ")} · status ${v.status}`,
        href:
          v.status === "scheduled"
            ? `/visits/${v.id}/document`
            : `/visits/${v.id}/document`,
        occurredAt: (v.scheduled_start ?? new Date()).toISOString(),
      });
    }

    for (const r of requests) {
      out.push({
        key: `req:${r.id}`,
        kind: "attestation_request",
        title: `Resolve attestation request — ${r.cpt_code}`,
        subtitle: `${r.attribute.replace(/_/g, " ")}${r.state ? ` · ${r.state}` : ""}`,
        href: `/payers/attestations/new?requestId=${r.id}&cptCode=${r.cpt_code}&attribute=${r.attribute}${r.state ? `&state=${r.state}` : ""}`,
        occurredAt: (r.claimed_at ?? new Date()).toISOString(),
      });
    }

    for (const d of denials) {
      out.push({
        key: `den:${d.id}`,
        kind: "denial",
        title: `Pending denial — ${d.cpt_code} · CARC ${d.carc_code}`,
        subtitle: `$${(Number(d.denied_amount_cents) / 100).toFixed(2)} denied · awaiting decision`,
        href: `/billing/denials/${d.id}`,
        occurredAt: d.denied_at.toISOString(),
      });
    }

    out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    return out.slice(0, limit);
  });
}
