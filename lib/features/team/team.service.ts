/**
 * Team service — invite + permission grants per vision §18.7.
 *
 * Flow:
 *   1. Org admin enters email + selects role template → permission set
 *      defaults from §13.4.
 *   2. Toggles individual permissions ON/OFF before sending.
 *   3. INSERT a `pending_invite` row + N `user_permission` rows in a tx.
 *   4. On accept, update each permission row's `user_id` and delete
 *      the pending_invite.
 */
import { NotFoundError, SeatLimitError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { sendEmail } from "@/lib/email/email.service";
import { inviteEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";
import type { Tier } from "@/lib/features/billing-saas/stripe.service";
import { resolveSeatCap, wouldExceedSeatCap } from "./seat-limit";
import {
  InviteSchema,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_TEMPLATES,
  type InviteInput,
  type InviteRecord,
  type MemberRecord,
  type RoleTemplate,
} from "./team.types";

export {
  InviteSchema,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_TEMPLATES,
  type InviteInput,
  type InviteRecord,
  type MemberRecord,
  type RoleTemplate,
};

/**
 * Resolve the org's seat cap inside an open tx: prefer the paid
 * subscription seat count, fall back to org.plan_tier.
 */
async function resolveOrgSeatCap(
  tx: { $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T> },
  orgId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<
    { subscription_seats: number | null; plan_tier: Tier }[]
  >`
    SELECT s.seats AS subscription_seats, o.plan_tier AS plan_tier
      FROM org o
      LEFT JOIN subscription s ON s.org_id = o.id
     WHERE o.id = ${orgId}::uuid
     LIMIT 1
  `;
  const r = rows[0];
  return resolveSeatCap({
    subscriptionSeats: r?.subscription_seats ?? null,
    planTier: r?.plan_tier ?? "solo",
  });
}

export async function createInvite(args: {
  orgId: string;
  invitedByUserId: string;
  payload: InviteInput;
}): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000);
  return withOrgContext(args.orgId, async (tx) => {
    // ---- Seat-limit guard (gap H) -------------------------------------
    // Re-inviting an email that's already a member or pending invite
    // updates that row in place (ON CONFLICT) — no new seat consumed.
    const existing = await tx.$queryRaw<{ kind: string }[]>`
      SELECT 'invite' AS kind
        FROM pending_invite
       WHERE org_id = ${args.orgId}::uuid AND email = ${args.payload.email}
      UNION ALL
      SELECT 'member' AS kind
        FROM org_member m JOIN app_user u ON u.id = m.user_id
       WHERE m.org_id = ${args.orgId}::uuid
         AND u.email = ${args.payload.email}::citext
         AND m.status = 'active'
      LIMIT 1
    `;
    const reInvitingExisting = existing.length > 0;

    const usage = await tx.$queryRaw<
      { active_members: bigint; outstanding_invites: bigint }[]
    >`
      SELECT
        (SELECT COUNT(*) FROM org_member
          WHERE org_id = ${args.orgId}::uuid AND status = 'active')
          AS active_members,
        (SELECT COUNT(*) FROM pending_invite
          WHERE org_id = ${args.orgId}::uuid AND expires_at > now())
          AS outstanding_invites
    `;
    const cap = await resolveOrgSeatCap(tx, args.orgId);
    if (
      wouldExceedSeatCap({
        activeMembers: Number(usage[0]?.active_members ?? 0),
        outstandingInvites: Number(usage[0]?.outstanding_invites ?? 0),
        cap,
        reInvitingExisting,
      })
    ) {
      throw new SeatLimitError(
        `Your plan includes ${cap} seat${cap === 1 ? "" : "s"}. ` +
          `Upgrade in Settings → Billing to invite more teammates.`,
      );
    }
    // -------------------------------------------------------------------

    const inv = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO pending_invite (
        org_id, email, role_template, invited_by_user_id, token, expires_at
      ) VALUES (
        ${args.orgId}::uuid, ${args.payload.email}, ${args.payload.roleTemplate},
        ${args.invitedByUserId}::uuid, ${token}, ${expiresAt}::timestamptz
      )
      ON CONFLICT (org_id, email) DO UPDATE SET
        role_template = EXCLUDED.role_template,
        token = EXCLUDED.token,
        expires_at = EXCLUDED.expires_at,
        invited_by_user_id = EXCLUDED.invited_by_user_id
      RETURNING id
    `;
    const inviteId = inv[0]!.id;

    await tx.$executeRaw`
      DELETE FROM user_permission WHERE pending_invite_id = ${inviteId}::uuid
    `;
    for (const perm of args.payload.permissions) {
      await tx.$executeRaw`
        INSERT INTO user_permission (
          org_id, pending_invite_id, permission, granted_by_user_id
        ) VALUES (
          ${args.orgId}::uuid, ${inviteId}::uuid, ${perm}, ${args.invitedByUserId}::uuid
        )
      `;
    }

    return { id: inviteId, token };
  }).then(async (result) => {
    void sendInviteEmail({
      orgId: args.orgId,
      inviteeEmail: args.payload.email,
      inviterUserId: args.invitedByUserId,
      token: result.token,
      expiresAt: expiresAt.toISOString(),
    });
    return result;
  });
}

async function sendInviteEmail(input: {
  orgId: string;
  inviteeEmail: string;
  inviterUserId: string;
  token: string;
  expiresAt: string;
}): Promise<void> {
  try {
    const meta = await withOrgContext(input.orgId, async (tx) => {
      const orgRow = await tx.$queryRaw<{ name: string }[]>`
        SELECT name FROM org WHERE id = ${input.orgId}::uuid LIMIT 1
      `;
      const branding = await tx.$queryRaw<
        { display_name: string | null; primary_color: string | null; logo_url: string | null;
          email_from_name: string | null; email_from_address: string | null }[]
      >`
        SELECT display_name, primary_color, logo_url, email_from_name, email_from_address
        FROM org_branding WHERE org_id = ${input.orgId}::uuid LIMIT 1
      `;
      const inviter = await tx.$queryRaw<{ full_name: string | null; email: string }[]>`
        SELECT full_name, email FROM app_user WHERE id = ${input.inviterUserId}::uuid LIMIT 1
      `;
      return {
        orgName: orgRow[0]?.name ?? "your organization",
        branding: branding[0] ?? null,
        inviterName: inviter[0]?.full_name ?? inviter[0]?.email ?? "A teammate",
      };
    });

    const acceptUrl = `${env().APP_BASE_URL}/invites/${input.token}`;
    const tmpl = inviteEmail({
      inviteeEmail: input.inviteeEmail,
      inviterName: meta.inviterName,
      acceptUrl,
      expiresAt: input.expiresAt,
      branding: {
        displayName: meta.branding?.display_name ?? meta.orgName,
        primaryColor: meta.branding?.primary_color ?? null,
        logoUrl: meta.branding?.logo_url ?? null,
      },
    });

    await sendEmail({
      to: input.inviteeEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
      fromName: meta.branding?.email_from_name ?? meta.orgName,
      fromAddress: meta.branding?.email_from_address ?? undefined,
    });
  } catch (err) {
    console.error("invite email send failed", {
      err: err instanceof Error ? err.message : String(err),
      to: input.inviteeEmail,
    });
  }
}

export async function listInvites(args: {
  orgId: string;
}): Promise<InviteRecord[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        email: string;
        role_template: RoleTemplate;
        invited_by_user_id: string;
        expires_at: Date;
        created_at: Date;
        redeemed_at: Date | null;
      }[]
    >`
      SELECT id, email, role_template, invited_by_user_id,
             expires_at, created_at, redeemed_at
      FROM pending_invite
      WHERE redeemed_at IS NULL
      ORDER BY created_at DESC
    `;

    if (rows.length === 0) return [];

    const inviteIds = rows.map((r) => r.id);
    const perms = await tx.$queryRaw<
      { pending_invite_id: string; permission: string }[]
    >`
      SELECT pending_invite_id, permission FROM user_permission
      WHERE pending_invite_id = ANY(${inviteIds}::uuid[])
    `;
    const permsByInvite = new Map<string, string[]>();
    for (const p of perms) {
      const a = permsByInvite.get(p.pending_invite_id) ?? [];
      a.push(p.permission);
      permsByInvite.set(p.pending_invite_id, a);
    }

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      roleTemplate: r.role_template,
      invitedByUserId: r.invited_by_user_id,
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      redeemedAt: r.redeemed_at?.toISOString() ?? null,
      permissions: permsByInvite.get(r.id) ?? [],
    }));
  });
}

export async function listMembers(args: {
  orgId: string;
  /**
   * Restrict to ACTIVE org members (org_member.status = 'active'). Care-team
   * pickers must use this: the default (permission-based) list can include
   * suspended/removed members whose assignment the patient service rejects
   * with a 422 — a roster/validator mismatch that hard-failed intake.
   */
  activeOnly?: boolean;
}): Promise<MemberRecord[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        user_id: string;
        email: string;
        full_name: string | null;
        permissions: string[];
      }[]
    >`
      SELECT
        up.user_id,
        u.email,
        u.full_name,
        array_agg(up.permission ORDER BY up.permission) AS permissions
      FROM user_permission up
      JOIN app_user u ON u.id = up.user_id
      WHERE up.user_id IS NOT NULL
        AND (
          ${!args.activeOnly}
          OR EXISTS (
            SELECT 1 FROM org_member om
            WHERE om.user_id = up.user_id AND om.org_id = up.org_id
              AND om.status = 'active'
          )
        )
      GROUP BY up.user_id, u.email, u.full_name
      ORDER BY u.email
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      fullName: r.full_name,
      permissions: r.permissions,
    }));
  });
}

export async function setMemberPermissions(args: {
  orgId: string;
  userId: string;
  permissions: string[];
  grantedByUserId: string;
}): Promise<{ before: number; after: number }> {
  return withOrgContext(args.orgId, async (tx) => {
    // Member must exist for THIS tenant — RLS filters user_permission by
    // org_id so beforeRow would be 0 for a cross-tenant user_id too.
    // Explicit existence check via org_member gives a cleaner 404.
    const member = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM org_member
       WHERE org_id = ${args.orgId}::uuid
         AND user_id = ${args.userId}::uuid
         AND status = 'active'
       LIMIT 1
    `;
    if (member.length === 0) throw new NotFoundError("Member not found in this org.");

    const beforeRow = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM user_permission
      WHERE user_id = ${args.userId}::uuid
    `;
    await tx.$executeRaw`
      DELETE FROM user_permission WHERE user_id = ${args.userId}::uuid
    `;
    for (const perm of args.permissions) {
      await tx.$executeRaw`
        INSERT INTO user_permission (
          org_id, user_id, permission, granted_by_user_id
        ) VALUES (
          ${args.orgId}::uuid, ${args.userId}::uuid, ${perm}, ${args.grantedByUserId}::uuid
        )
        ON CONFLICT DO NOTHING
      `;
    }
    return { before: beforeRow[0]?.n ?? 0, after: args.permissions.length };
  });
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
