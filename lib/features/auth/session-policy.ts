/**
 * How long a session lasts without activity, and who must sign in with a
 * second factor (0121; security roadmap Phase 0, 30 Oct 2026).
 *
 * A session lasted 7 days with no idle limit, and MFA was optional for every
 * user, admins and billers included. HIPAA asks for automatic logoff
 * (164.312(a)(2)(iii)) and ONC tests it ((d)(5)), and the proposed Security
 * Rule makes MFA required; the roadmap's floor is MFA for anyone who can
 * change access, the practice's settings or its claims.
 *
 * Pure except readSessionPolicy, and safe to import from the server only.
 */
import { withOrgContext } from "@/lib/db";

export const MFA_POLICIES = ["admins_and_billers", "everyone"] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];

/**
 * The org's idle limit, in minutes: 30 unless the practice sets another
 * (decided 31 Oct 2026 over the roadmap's 15, which cut into a home visit's
 * conversation; 0121).
 */
export const IDLE_MINUTES = { min: 5, max: 120, default: 30 } as const;

export interface SessionPolicy {
  idleMinutes: number;
  mfaPolicy: MfaPolicy;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMinutes: IDLE_MINUTES.default,
  mfaPolicy: "admins_and_billers",
};

/**
 * Grants that make a member an admin or a biller whatever their template:
 * changing who may do what, the practice's settings and connections, and
 * claims (editing, exporting, refiling, writing off). A clinician granted any
 * of these holds the same keys an admin or biller does.
 */
export const MFA_SENSITIVE_PERMISSIONS: readonly string[] = [
  "team.invite",
  "team.permissions",
  "team.deactivate",
  "settings.org",
  "settings.payers",
  "settings.integrations",
  "billing.superbills.edit",
  "billing.superbills.export",
  "billing.denials.refile",
  "billing.denials.writeoff",
];

const SENSITIVE = new Set(MFA_SENSITIVE_PERMISSIONS);

/** Whether this person must sign in with a second factor. */
export function mfaRequiredFor(role: string, permissions: readonly string[], policy: MfaPolicy): boolean {
  if (policy === "everyone") return true;
  if (role === "platform_admin" || role === "org_admin" || role === "billing_agent") return true;
  return permissions.some((p) => SENSITIVE.has(p));
}

/** Whether a session last used at `act` (epoch seconds) has passed its idle limit. */
export function sessionIsIdle(state: { act: number; idle: number }, nowSec: number): boolean {
  return nowSec - state.act > state.idle * 60;
}

/**
 * A longer idle limit for local development only, so a developer's session
 * survives the time between browser checks. Ignored in production, like
 * CLEARINGHOUSE_ALLOW_PRIVATE_HOSTS.
 */
function devIdleOverride(): number | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = process.env.PALLIO_DEV_IDLE_MINUTES;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 24 * 60 ? n : null;
}

/**
 * The org's idle limit and MFA policy. A failed read falls back to the
 * defaults, which are the strict end: a session is never given longer, or a
 * second factor waived, because the database was slow.
 */
export async function readSessionPolicy(orgId: string): Promise<SessionPolicy> {
  let policy = DEFAULT_SESSION_POLICY;
  try {
    const rows = await withOrgContext(orgId, (tx) =>
      tx.$queryRaw<{ idle_timeout_minutes: number; mfa_policy: string }[]>`
        SELECT idle_timeout_minutes, mfa_policy FROM org WHERE id = ${orgId}::uuid LIMIT 1
      `,
    );
    const r = rows[0];
    if (r) {
      policy = {
        idleMinutes: Number(r.idle_timeout_minutes),
        mfaPolicy: (MFA_POLICIES as readonly string[]).includes(r.mfa_policy)
          ? (r.mfa_policy as MfaPolicy)
          : DEFAULT_SESSION_POLICY.mfaPolicy,
      };
    }
  } catch {
    policy = DEFAULT_SESSION_POLICY;
  }
  const dev = devIdleOverride();
  return dev === null ? policy : { ...policy, idleMinutes: dev };
}
