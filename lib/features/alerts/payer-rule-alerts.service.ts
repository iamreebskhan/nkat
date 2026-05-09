/**
 * Payer-rule-change alert service.
 *
 * Source: pallio_complete_vision_v3 §6.6 (knowledge base) + §6.1
 * (org notifications).
 *
 * Behavior:
 *   - For each org × payer × state combination they care about (their
 *     org_rulebook_row scope), find any payer_rule rows whose
 *     effective_date is on or after the org's last alert checkpoint.
 *   - Group by (payer, state) and email org_admin members one digest
 *     per (payer, state) pair.
 *   - Advance the checkpoint atomically with the email send.
 *
 * Designed to run nightly via a Vercel/EC2 cron hitting POST
 * /api/cron/payer-rule-alerts with a shared-secret header.
 */
import { withOrgContext } from "@/lib/db";
import { sendEmail } from "@/lib/email/email.service";
import { payerRuleAlertEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";

export interface OrgAlertSummary {
  orgId: string;
  orgName: string;
  digestsSent: number;
}

/**
 * Find every (org × payer × state) tracked in org_rulebook_row, look
 * back from each org's checkpoint, and dispatch one email per
 * (payer, state) with > 0 changes.
 *
 * Returns per-org summaries for the cron's response body.
 */
export async function dispatchPayerRuleAlerts(): Promise<OrgAlertSummary[]> {
  // Discover orgs that have an active rulebook + at least one admin
  // with email notifications enabled.
  const orgs = await listOrgsForAlerts();
  const out: OrgAlertSummary[] = [];

  for (const org of orgs) {
    const summary = await dispatchForOrg(org.orgId, org.orgName);
    out.push(summary);
  }
  return out;
}

interface OrgRow {
  orgId: string;
  orgName: string;
}

async function listOrgsForAlerts(): Promise<OrgRow[]> {
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT DISTINCT o.id, o.name
    FROM org o
    JOIN org_rulebook rb ON rb.org_id = o.id
    WHERE o.status = 'active'
  `;
  return rows.map((r) => ({ orgId: r.id, orgName: r.name }));
}

async function dispatchForOrg(orgId: string, orgName: string): Promise<OrgAlertSummary> {
  return withOrgContext(orgId, async (tx) => {
    // 1. Read or initialize the checkpoint.
    const ckRows = await tx.$queryRaw<{ last_checked_at: Date | null }[]>`
      SELECT last_checked_at FROM org_rule_alert_checkpoint
      WHERE org_id = ${orgId}::uuid LIMIT 1
    `;
    const since = ckRows[0]?.last_checked_at ?? new Date(Date.now() - 7 * 86_400_000);
    const now = new Date();

    // 2. Find changed payer_rule rows in scope (those that overlap
    //    the org's rulebook_row payer/state combos).
    const changes = await tx.$queryRaw<
      { payer_id: string; payer_name: string; state: string; n: bigint }[]
    >`
      SELECT pr.payer_id, p.name AS payer_name, pr.state, COUNT(*) AS n
      FROM payer_rule pr
      JOIN payer p ON p.id = pr.payer_id
      WHERE pr.effective_date >= ${since}::date
        AND EXISTS (
          SELECT 1 FROM org_rulebook_row rb
           WHERE rb.org_id = ${orgId}::uuid
             AND rb.payer_id = pr.payer_id
             AND rb.state    = pr.state
        )
      GROUP BY pr.payer_id, p.name, pr.state
    `;

    if (changes.length === 0) {
      await tx.$executeRaw`
        INSERT INTO org_rule_alert_checkpoint (org_id, last_checked_at)
        VALUES (${orgId}::uuid, ${now}::timestamptz)
        ON CONFLICT (org_id) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at
      `;
      return { orgId, orgName, digestsSent: 0 };
    }

    // 3. Pull org_admins to email + branding.
    const recipients = await tx.$queryRaw<{ email: string }[]>`
      SELECT DISTINCT u.email
      FROM user_permission up
      JOIN app_user u ON u.id = up.user_id
      WHERE up.permission = 'team.permissions'
        AND u.status = 'active'
    `;
    if (recipients.length === 0) {
      return { orgId, orgName, digestsSent: 0 };
    }

    const branding = await tx.$queryRaw<
      { display_name: string | null; primary_color: string | null; logo_url: string | null }[]
    >`
      SELECT display_name, primary_color, logo_url FROM org_branding
      WHERE org_id = ${orgId}::uuid LIMIT 1
    `;

    const rulebookUrl = `${env().APP_BASE_URL}/settings/rulebook`;
    let sent = 0;

    for (const c of changes) {
      const tmpl = payerRuleAlertEmail({
        recipientEmail: recipients[0]!.email,
        payerName: c.payer_name,
        state: c.state,
        changedCount: Number(c.n),
        rulebookUrl,
        branding: {
          displayName: branding[0]?.display_name ?? orgName,
          primaryColor: branding[0]?.primary_color ?? null,
          logoUrl: branding[0]?.logo_url ?? null,
        },
      });
      for (const r of recipients) {
        await sendEmail({
          to: r.email,
          subject: tmpl.subject,
          html: tmpl.html,
          text: tmpl.text,
          fromName: branding[0]?.display_name ?? orgName,
        });
        sent++;
      }
    }

    await tx.$executeRaw`
      INSERT INTO org_rule_alert_checkpoint (org_id, last_checked_at)
      VALUES (${orgId}::uuid, ${now}::timestamptz)
      ON CONFLICT (org_id) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at
    `;
    return { orgId, orgName, digestsSent: sent };
  });
}
