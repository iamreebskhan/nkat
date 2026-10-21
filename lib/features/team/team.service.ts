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
import { NotFoundError, SeatLimitError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { sendEmail } from "@/lib/email/email.service";
import { inviteEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/features/audit/audit-write";
import type { Tier } from "@/lib/features/billing-saas/stripe.service";
import { resolveSeatCap, wouldExceedSeatCap } from "./seat-limit";
import {
  InviteSchema,
  MemberPermissionsSchema,
  PERMISSION_SET_REQUIRED,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_TEMPLATES,
  unknownPermissionMessage,
  unknownPermissions,
  type InviteInput,
  type InviteRecord,
  type MemberRecord,
  type RoleTemplate,
} from "./team.types";

export {
  InviteSchema,
  MemberPermissionsSchema,
  PERMISSION_SET_REQUIRED,
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
    // AWAITED, and the outcome is returned.
    //
    // This was `void sendInviteEmail(...)` — fire and forget — so the API
    // answered before the send was even attempted and no caller could learn
    // what happened. With RESEND_API_KEY unset, sendEmail logs the message to
    // stdout and returns delivered:false; the invite row is written, the UI
    // says the invite went out, and the colleague waits for an email that was
    // never sent. On a product whose next job is onboarding a customer's
    // team, that is the worst possible place for a silent no-op.
    //
    // acceptUrl comes back either way, so an admin can always send the link
    // by hand — onboarding does not become impossible just because outbound
    // email is not configured yet.
    const acceptUrl = `${env().APP_BASE_URL}/invites/${result.token}`;
    const emailDelivered = await sendInviteEmail({
      orgId: args.orgId,
      inviteeEmail: args.payload.email,
      inviterUserId: args.invitedByUserId,
      token: result.token,
      expiresAt: expiresAt.toISOString(),
    });
    return { ...result, acceptUrl, emailDelivered };
  });
}

async function sendInviteEmail(input: {
  orgId: string;
  inviteeEmail: string;
  inviterUserId: string;
  token: string;
  expiresAt: string;
  /** True only when the message actually left the building. */
}): Promise<boolean> {
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

    const sent = await sendEmail({
      to: input.inviteeEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
      fromName: meta.branding?.email_from_name ?? meta.orgName,
      fromAddress: meta.branding?.email_from_address ?? undefined,
    });
    if (!sent.delivered) {
      console.warn(
        `invite email NOT delivered to ${input.inviteeEmail} — no RESEND_API_KEY; ` +
          `the message was written to stdout. Send the accept link by hand.`,
      );
    }
    return sent.delivered;
  } catch (err) {
    console.error("invite email send failed", {
      err: err instanceof Error ? err.message : String(err),
      to: input.inviteeEmail,
    });
    return false;
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
      -- The org is named here rather than left to RLS alone. On a
      -- connection that bypasses RLS (.env.local notes that the preview
      -- deployment runs as a superuser), this query without the predicate
      -- would list every org's outstanding invites on /team and the page
      -- header would count them. The local database has one from another org.
      WHERE org_id = ${args.orgId}::uuid
        AND redeemed_at IS NULL
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
   * Restrict to ACTIVE org members (org_member.status = 'active'). Every
   * screen that offers a member as a CHOICE passes this — /team's roster, the
   * two care-team pickers, and the schedule's PTO and visit composers. The
   * default list can include suspended/removed members, and offering one is
   * always a dead end: the patient service rejects the assignment with a 422,
   * setMemberPermissions 404s the row below, and time-off/visit INSERTs accept
   * the id with no membership check at all. The unfiltered default is for a
   * caller that genuinely wants the whole membership list; no screen does.
   */
  activeOnly?: boolean;
}): Promise<MemberRecord[]> {
  return withOrgContext(args.orgId, async (tx) => {
    // org_member is the roster of record, so it drives the query and
    // user_permission is LEFT JOINed onto it.
    //
    // This used to run the other way round — FROM user_permission, with
    // org_member only an EXISTS filter — and a member holding no permission
    // rows produced no GROUP BY group at all, so they were missing from /team
    // entirely: not listed, not editable, impossible to grant anything to. On
    // the Design Partner org that hid three of five active members, including
    // every consultant (the consultant template starts empty by design).
    // Re-inviting was the only way back.
    const rows = await tx.$queryRaw<
      {
        user_id: string;
        email: string;
        full_name: string | null;
        permissions: string[];
        npi: string | null;
        credential: string | null;
      }[]
    >`
      SELECT
        om.user_id,
        u.email,
        u.full_name,
        -- FILTER drops the single NULL the LEFT JOIN produces for a member
        -- with no grants; COALESCE turns that into an empty set rather than
        -- NULL, which the roster renders as "0 permissions".
        COALESCE(
          array_agg(up.permission ORDER BY up.permission)
            FILTER (WHERE up.permission IS NOT NULL),
          '{}'
        )::text[] AS permissions,
        -- The clinician's billing identity (audit R40, R25).
        cp.npi,
        cp.credential
      FROM org_member om
      JOIN app_user u ON u.id = om.user_id
      -- org_id twice, for two different jobs, and neither is redundant with
      -- RLS. On the join it bounds the GRANTS: multi@example.test belongs to
      -- two orgs, and without it that member came back as ONE row holding
      -- both orgs' 8 permissions — which the editor then writes back
      -- wholesale. In the WHERE it bounds the ROSTER, as listInvites and
      -- setMemberPermissions do. Under the app role RLS bounds it too, but
      -- .env.local notes that the preview deployment connects as a superuser,
      -- which bypasses RLS, and on that connection the query without this
      -- line returns all 18 members of every org (checked against the local
      -- database).
      LEFT JOIN user_permission up
             ON up.user_id = om.user_id AND up.org_id = om.org_id
      LEFT JOIN clinician_profile cp
             ON cp.org_id = om.org_id AND cp.user_id = om.user_id
      WHERE om.org_id = ${args.orgId}::uuid
        AND (${!args.activeOnly} OR om.status = 'active')
      -- The WHERE already pins om.org_id, so grouping by it changes nothing
      -- today. It is a backstop: if that predicate is ever lost, a two-org
      -- member still comes back as one row per org instead of one row
      -- carrying both orgs' grants.
      GROUP BY om.org_id, om.user_id, u.email, u.full_name, cp.npi, cp.credential
      ORDER BY u.email
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      fullName: r.full_name,
      permissions: r.permissions,
      npi: r.npi,
      credential: r.credential,
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
    // "active members" matters: a suspended or removed member IS in the org,
    // and the old "not found in this org" told the admin something untrue.
    if (member.length === 0) {
      throw new NotFoundError("Member not found among this org's active members.");
    }

    // An empty set is refused here, not just at the route: this is the layer
    // that would otherwise DELETE every row and INSERT none, leaving a member
    // who can sign in and reach nothing. The invite path has always refused
    // the same input (InviteSchema) — the editor simply never inherited it.
    if (args.permissions.length === 0) {
      throw new ValidationError(PERMISSION_SET_REQUIRED);
    }

    // And the same for the NAMES, for the same reason and at the same layer.
    // The catalogue arrived as a rule on the route's body schema only, which
    // left the two halves of one rule at different depths: an empty set was
    // refused here as well as there, a misspelt name only there. The rows
    // below are written from args.permissions verbatim, so any caller reaching
    // this function another way — a second route, a script, a background job —
    // would INSERT "patients.vieww" into user_permission, listMembers would
    // read it back, and /team would show the member a grant no requireAuth
    // list can ever match. Checked before the DELETE, so a refused save leaves
    // the member's existing grants exactly where they were.
    const unknown = unknownPermissions(args.permissions);
    if (unknown.length > 0) {
      throw new ValidationError(unknownPermissionMessage(unknown));
    }

    // Both statements name the org as well as the user. A user can belong to
    // more than one org (multi@example.test does, with 4 grants in each), and
    // on a connection that bypasses RLS a user-only DELETE would remove all 8.
    // Saving this org's editor would wipe the member's access in the other
    // org, and the audit entry would list the other org's grants as removed
    // here.
    const beforeRows = await tx.$queryRaw<{ permission: string }[]>`
      SELECT permission FROM user_permission
      WHERE user_id = ${args.userId}::uuid
        AND org_id = ${args.orgId}::uuid
    `;
    const before = new Set(beforeRows.map((r) => r.permission));
    await tx.$executeRaw`
      DELETE FROM user_permission
      WHERE user_id = ${args.userId}::uuid
        AND org_id = ${args.orgId}::uuid
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
    // Who may do what is the org's own control, and a change to it that left
    // no trace is exactly what an audit log exists to catch (audit R38).
    const after = new Set(args.permissions);
    const added = [...after].filter((p) => !before.has(p)).sort();
    const removed = [...before].filter((p) => !after.has(p)).sort();
    if (added.length > 0 || removed.length > 0) {
      await writeAudit(tx, {
        orgId: args.orgId,
        userId: args.grantedByUserId,
        action: "team_permissions_update",
        targetType: "user",
        targetId: args.userId,
        payload: { added, removed },
      });
    }
    return { before: before.size, after: args.permissions.length };
  });
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
