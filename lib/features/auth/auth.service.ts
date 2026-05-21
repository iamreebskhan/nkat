/**
 * Auth service — DB-backed login + signup.
 *
 * Source: pallio_complete_vision_v3 §18.3.
 *
 * Login flow:
 *   1. Look up app_user by email.
 *   2. Verify bcrypt hash.
 *   3. Resolve org (single org per user for now; multi-org via org_picker
 *      lands once a real customer needs it).
 *   4. Read user_permission rows for that org × user.
 *   5. Caller signs the session JWT.
 *
 * Signup flow:
 *   1. Create the org row + slug.
 *   2. Create the app_user row (bcrypt hash).
 *   3. Insert org_member at role='admin', status='active'.
 *   4. Grant the org_admin default permission set.
 *   5. Stamp baa_signed_at on the org if BAA was accepted.
 *   6. Caller signs the session JWT for the new user.
 */
import bcrypt from "bcryptjs";

import { prisma, withBreakglass, withOrgContext } from "@/lib/db";
import {
  ROLE_DEFAULT_PERMISSIONS,
} from "@/lib/features/team/team.types";
import type { Session } from "@/lib/auth";

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LEN = 12;

export interface LoginInput {
  email: string;
  password: string;
  /** Required if the account has MFA enrolled; otherwise ignored. */
  mfaCode?: string;
}

export interface LoginSuccess {
  session: Session;
}

export type LoginResult =
  | LoginSuccess
  | { error: "invalid_credentials" }
  | { error: "user_inactive" }
  | { error: "mfa_required" }
  | { error: "mfa_bad_code" };

export async function login(input: LoginInput): Promise<LoginResult> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      email: string;
      password_hash: string | null;
      status: string;
    }[]
  >`
    SELECT id, email, password_hash, status, is_platform_admin
    FROM app_user
    WHERE email = ${input.email}::citext
    LIMIT 1
  `;
  const user = rows[0] as
    | { id: string; email: string; password_hash: string | null; status: string; is_platform_admin: boolean }
    | undefined;
  // Always run a bcrypt compare even on no-such-user to keep timing constant.
  const dummyHash = "$2a$12$AAAAAAAAAAAAAAAAAAAAAOaaKvg5j/Y9JZ9Gq3pXk4t5bHJX/Vbpu";
  const ok = await bcrypt.compare(input.password, user?.password_hash ?? dummyHash);
  if (!user || !user.password_hash || !ok) {
    return { error: "invalid_credentials" };
  }
  if (user.status !== "active") {
    return { error: "user_inactive" };
  }

  // MFA gate. If the account has enrolled, require + verify the code.
  const mfaRows = await prisma.$queryRaw<
    { mfa_enrolled_at: Date | null }[]
  >`
    SELECT mfa_enrolled_at FROM app_user WHERE id = ${user.id}::uuid LIMIT 1
  `;
  if (mfaRows[0]?.mfa_enrolled_at) {
    if (!input.mfaCode) return { error: "mfa_required" };
    const { verifyMfaChallenge } = await import("./mfa.service");
    const okMfa = await verifyMfaChallenge({ userId: user.id, code: input.mfaCode });
    if (!okMfa) return { error: "mfa_bad_code" };
  }

  // Login is pre-tenant: we don't know which org the user belongs to until
  // we look it up. Use breakglass to read across the org boundary — the
  // result is then used to set app.current_org_id for all subsequent calls.
  const orgRows = await withBreakglass(
    (client) => client.$queryRaw<
      { org_id: string; role: string; org_status: string }[]
    >`
      SELECT m.org_id, m.role, o.status AS org_status
      FROM org_member m JOIN org o ON o.id = m.org_id
      WHERE m.user_id = ${user.id}::uuid
        AND m.status = 'active'
        AND o.deleted_at IS NULL
      ORDER BY m.joined_at ASC
      LIMIT 1
    `,
    "login: resolve org for authenticated user",
  );
  const member = orgRows[0];
  if (!member || member.org_status !== "active") {
    return { error: "user_inactive" };
  }

  const permissions = await withOrgContext(member.org_id, async (tx) => {
    const r = await tx.$queryRaw<{ permission: string }[]>`
      SELECT permission FROM user_permission
      WHERE user_id = ${user.id}::uuid
      ORDER BY permission
    `;
    return r.map((x) => x.permission);
  });

  await prisma.$executeRaw`
    UPDATE app_user SET last_login_at = now() WHERE id = ${user.id}::uuid
  `;

  return {
    session: {
      userId: user.id,
      orgId: member.org_id,
      // is_platform_admin trumps the org-member role mapping so the
      // operator (Mark) can hit /api/admin/* + /admin/* without
      // belonging to any specific org's role.
      role: user.is_platform_admin
        ? "platform_admin"
        : mapDbRoleToSession(member.role),
      permissions,
      email: user.email,
    },
  };
}

function mapDbRoleToSession(dbRole: string): Session["role"] {
  // org_member.role uses the legacy four-value enum; the JWT role is
  // for sidebar rendering only — server gates everything by permissions.
  if (dbRole === "admin") return "org_admin";
  if (dbRole === "consultant") return "consultant";
  if (dbRole === "reviewer") return "analyst";
  return "clinician";
}

export interface SignupInput {
  email: string;
  password: string;
  fullName: string;
  orgName: string;
  baaAccepted: boolean;
}

export type SignupResult =
  | { session: Session }
  | { error: "email_taken" }
  | { error: "weak_password" }
  | { error: "baa_required" }
  | { error: "org_name_taken" };

/**
 * Self-serve signup. Creates org + admin user + permission rows + org_member
 * entry transactionally so a failure leaves no half-state.
 */
export async function signup(input: SignupInput): Promise<SignupResult> {
  if (input.password.length < MIN_PASSWORD_LEN) return { error: "weak_password" };
  if (!input.baaAccepted) return { error: "baa_required" };

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const slug = slugify(input.orgName);
  const adminPerms = ROLE_DEFAULT_PERMISSIONS.org_admin;

  // First check uniqueness — Postgres unique violations would also catch
  // these, but the explicit check yields cleaner error codes for the UI.
  const existingEmail = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM app_user WHERE email = ${input.email}::citext LIMIT 1
  `;
  if (existingEmail[0]) return { error: "email_taken" };

  const existingSlug = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM org WHERE slug = ${slug}::citext LIMIT 1
  `;
  if (existingSlug[0]) return { error: "org_name_taken" };

  // Pre-generate the org UUID so we can SET LOCAL app.current_org_id BEFORE
  // the INSERT — RLS on `org` requires id = app.current_org_id() to pass
  // WITH CHECK on the new row.
  const orgIdRows = await prisma.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
  const newOrgId = orgIdRows[0]!.id;

  const result = await prisma.$transaction(async (tx) => {
    // Set the GUC for the rest of this tx so every tenant-scoped INSERT
    // (org itself, org_member, user_permission) passes RLS.
    await tx.$executeRawUnsafe(`SET LOCAL app.current_org_id = '${newOrgId}'`);

    await tx.$executeRaw`
      INSERT INTO org (id, name, slug, plan_tier, baa_signed_at, primary_contact_email, status)
      VALUES (${newOrgId}::uuid, ${input.orgName}, ${slug}, 'solo', now(), ${input.email}::citext, 'active')
    `;
    const orgId = newOrgId;

    const userRows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO app_user (email, full_name, password_hash, status)
      VALUES (${input.email}::citext, ${input.fullName}, ${passwordHash}, 'active')
      RETURNING id
    `;
    const userId = userRows[0]!.id;

    await tx.$executeRaw`
      INSERT INTO org_member (org_id, user_id, role, status, joined_at)
      VALUES (${orgId}::uuid, ${userId}::uuid, 'admin', 'active', now())
    `;

    for (const perm of adminPerms) {
      await tx.$executeRaw`
        INSERT INTO user_permission (org_id, user_id, permission, granted_by_user_id)
        VALUES (${orgId}::uuid, ${userId}::uuid, ${perm}, ${userId}::uuid)
      `;
    }

    return { orgId, userId };
  });

  return {
    session: {
      userId: result.userId,
      orgId: result.orgId,
      role: "org_admin",
      permissions: adminPerms,
      email: input.email,
    },
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "org";
}
