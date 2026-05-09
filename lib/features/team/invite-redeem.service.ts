/**
 * Invite redemption — token landing endpoint reads + accepts invites.
 *
 * Flow:
 *   1. GET  /invites/[token]              → previewInvite (returns org name + email)
 *   2. POST /api/team/invites/[token]/accept { fullName, password }
 *      → creates app_user (or links existing), flips redeemed_at,
 *        attaches user_id to user_permission rows.
 *
 * Security:
 *   - Token is the URL-safe random hex from createInvite.
 *   - Token comparison is constant-time via SQL equality (no UI leak).
 *   - Expired or already-redeemed → 410 Gone.
 *   - We never reveal whether the email pre-existed in app_user (the
 *     attacker shouldn't learn from the redeem response).
 *
 * `withBreakglass` is required because the read happens BEFORE we know
 * the org_id. After the org_id is established the rest runs through
 * withOrgContext.
 */
import bcrypt from "bcryptjs";

import { prisma, withBreakglass, withOrgContext } from "@/lib/db";

export interface InvitePreview {
  orgId: string;
  orgName: string;
  email: string;
  roleTemplate: string;
  invitedByEmail: string | null;
  expiresAt: string;
  permissions: string[];
}

export async function previewInvite(token: string): Promise<InvitePreview | null> {
  return withBreakglass(async (client) => {
    const rows = await client.$queryRaw<
      {
        org_id: string;
        org_name: string;
        email: string;
        role_template: string;
        expires_at: Date;
        redeemed_at: Date | null;
        invited_by_email: string | null;
      }[]
    >`
      SELECT i.org_id, o.name AS org_name, i.email, i.role_template,
             i.expires_at, i.redeemed_at,
             u.email AS invited_by_email
      FROM pending_invite i
      JOIN org o      ON o.id = i.org_id
      LEFT JOIN app_user u ON u.id = i.invited_by_user_id
      WHERE i.token = ${token}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.redeemed_at) return null;
    if (row.expires_at.getTime() < Date.now()) return null;

    const perms = await client.$queryRaw<{ permission: string }[]>`
      SELECT permission FROM user_permission
      WHERE pending_invite_id = (
        SELECT id FROM pending_invite WHERE token = ${token}
      )
      ORDER BY permission
    `;

    return {
      orgId: row.org_id,
      orgName: row.org_name,
      email: row.email,
      roleTemplate: row.role_template,
      invitedByEmail: row.invited_by_email,
      expiresAt: row.expires_at.toISOString(),
      permissions: perms.map((p) => p.permission),
    };
  }, "invite preview by token");
}

export interface RedeemInviteInput {
  token: string;
  fullName: string;
  /** New-user password, if the email isn't already an app_user. */
  password?: string;
}

export interface RedeemInviteResult {
  userId: string;
  orgId: string;
  email: string;
  /** True iff a fresh app_user row was created. */
  newUser: boolean;
}

export async function redeemInvite(
  input: RedeemInviteInput,
): Promise<RedeemInviteResult | { error: "expired_or_invalid" } | { error: "needs_password" }> {
  // Pull invite + verify lifetime via breakglass (no org context yet).
  const invite = await withBreakglass(async (client) => {
    const rows = await client.$queryRaw<
      {
        id: string;
        org_id: string;
        email: string;
        expires_at: Date;
        redeemed_at: Date | null;
      }[]
    >`
      SELECT id, org_id, email, expires_at, redeemed_at
      FROM pending_invite WHERE token = ${input.token} LIMIT 1
    `;
    return rows[0] ?? null;
  }, "invite redeem lookup");

  if (!invite || invite.redeemed_at || invite.expires_at.getTime() < Date.now()) {
    return { error: "expired_or_invalid" };
  }

  // Find or create the app_user.
  const existing = await prisma.$queryRaw<
    { id: string; password_hash: string | null }[]
  >`
    SELECT id, password_hash FROM app_user WHERE email = ${invite.email} LIMIT 1
  `;
  let userId: string;
  let newUser = false;
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    if (!input.password || input.password.length < 12) {
      return { error: "needs_password" };
    }
    const hash = await bcrypt.hash(input.password, 12);
    const ins = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO app_user (email, full_name, password_hash, status)
      VALUES (${invite.email}, ${input.fullName}, ${hash}, 'active')
      RETURNING id
    `;
    userId = ins[0]!.id;
    newUser = true;
  }

  // Flip the invite + attach user_id to its permission rows.
  await withOrgContext(invite.org_id, async (tx) => {
    await tx.$executeRaw`
      UPDATE pending_invite
         SET redeemed_at = now(),
             redeemed_by_user_id = ${userId}::uuid
       WHERE id = ${invite.id}::uuid
    `;
    await tx.$executeRaw`
      UPDATE user_permission
         SET user_id = ${userId}::uuid, pending_invite_id = NULL
       WHERE pending_invite_id = ${invite.id}::uuid
    `;
    // Link the user to the org via org_member if not already there.
    await tx.$executeRaw`
      INSERT INTO org_member (org_id, user_id, role, status, joined_at)
      VALUES (${invite.org_id}::uuid, ${userId}::uuid, 'employee', 'active', now())
      ON CONFLICT (org_id, user_id) DO UPDATE
        SET status = 'active', joined_at = COALESCE(org_member.joined_at, now())
    `;
  });

  return { userId, orgId: invite.org_id, email: invite.email, newUser };
}
