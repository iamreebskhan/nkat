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
import {
  daysUntilExpiry,
  shouldRemindToday,
} from "@/lib/features/attestations/attestation-pure";

export type InboxItemKind = "visit" | "attestation_request" | "denial" | "attestation_expiring";

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
  /** True if the user has knowledge.attest — controls expiry reminders. */
  canAttest?: boolean;
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

    // §15.3 re-verification reminders: active attestations hitting the
    // 15/5/0-days-remaining marks TODAY (shouldRemindToday). Fetch the
    // ≤16-day window and let the pure helper pick today's exact marks.
    let expiring: {
      id: string;
      cpt_code: string;
      state: string | null;
      expires_at: Date;
      payer_name: string | null;
    }[] = [];
    if (args.canAttest) {
      // Bounded window [today, +16d): rows already past expiry can never hit a
      // 15/5/0 mark and — while they wait for the on-read sweep — would only
      // starve the LIMIT. ASC = most urgent first among today's reminders.
      expiring = await tx.$queryRaw`
        SELECT a.id, a.cpt_code, a.state, a.expires_at, p.name AS payer_name
        FROM analyst_attestation a
        LEFT JOIN payer p ON p.id = a.payer_id
        WHERE a.status = 'active'
          AND a.expires_at >= CURRENT_DATE
          AND a.expires_at <= (CURRENT_DATE + INTERVAL '16 days')
        ORDER BY a.expires_at ASC
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

    // §15.3 reminders fire on the exact 15/5/0-days-remaining marks (a
    // reminder SCHEDULE, not a standing queue — the attestations page's
    // freshness buckets give continuous visibility). occurredAt is "now":
    // these are today's reminders, so they sort with today's items instead
    // of a future expires_at pinning the least-urgent one to the top.
    const remindedAt = new Date().toISOString();
    for (const a of expiring) {
      const att = { status: "active" as const, expiresAt: a.expires_at };
      if (!shouldRemindToday(att)) continue;
      const remaining = daysUntilExpiry(a.expires_at);
      out.push({
        key: `att-exp:${a.id}`,
        kind: "attestation_expiring",
        title:
          remaining <= 0
            ? `Attestation expires TODAY — ${a.cpt_code}`
            : `Attestation expires in ${remaining} days — ${a.cpt_code}`,
        subtitle: `${a.payer_name ?? "payer"}${a.state ? ` · ${a.state}` : ""} · re-verify with the payer to keep the rule fresh`,
        href: "/payers/attestations",
        occurredAt: remindedAt,
      });
    }

    out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    return out.slice(0, limit);
  });
}
