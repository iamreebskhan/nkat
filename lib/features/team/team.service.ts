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
import { withOrgContext } from "@/lib/db";
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

export async function createInvite(args: {
  orgId: string;
  invitedByUserId: string;
  payload: InviteInput;
}): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000);
  return withOrgContext(args.orgId, async (tx) => {
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
  });
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
