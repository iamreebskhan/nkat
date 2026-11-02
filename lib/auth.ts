/**
 * Pallio authentication — JWT in HttpOnly cookie via jose.
 *
 * Source: pallio_complete_vision_v3 §18.3.
 *
 *   - Sign at login: signSession({ userId, orgId, role, permissions })
 *   - Verify on every request: requireAuth(['billing.lookup.view'])
 *   - Server Components read via getSession() (returns null if unauth'd)
 *
 * Permissions are an array of strings on the JWT payload — exact format
 * per vision §18.4. Roles are display-only (sidebar manifest); the
 * server never trusts the role for authorization decisions.
 *
 * The token also carries SessionState (0121): when the person last did
 * something, the org's idle limit, and whether they signed in with a second
 * factor that their role requires. A session past its idle limit is no
 * session at all, here, for every route and page, so the limit holds even
 * when the browser tab that would have signed out is closed.
 */
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "./env";
import { fail, type ApiResponse } from "./api";
import {
  mfaRequiredFor,
  readSessionPolicy,
  sessionIsIdle,
} from "@/lib/features/auth/session-policy";

export type Session = {
  userId: string;
  orgId: string;
  role:
    | "platform_admin"
    | "org_admin"
    | "clinician"
    | "intake_coordinator"
    | "billing_agent"
    | "consultant"
    | "analyst"
    | "read_only";
  permissions: string[];
  email: string;
};

/** What a session token carries beyond who and what (0121). */
export interface SessionState {
  /** When the person last did something in the app, epoch seconds. */
  act: number;
  /** Minutes without activity before the session ends: the org's setting. */
  idle: number;
  /** Signed in with a second factor. */
  mfa: boolean;
  /** A second factor is required of this person (their role, or the org's policy). */
  mfaReq: boolean;
}

export type SignedInSession = Session & SessionState;

/**
 * What requireAuth hands a route. The state is always there at runtime; it is
 * optional in the type so a route spec can stand in a plain Session.
 */
export type AuthedSession = Session & Partial<SessionState>;

/**
 * Tokens minted before 0121 carry no SessionState, so nothing says when they
 * were last used or whether their holder may skip a second factor. They are
 * refused and everyone signs in once.
 */
const SESSION_VERSION = 2;

const ALG = "HS256";

function secret(): Uint8Array {
  return new TextEncoder().encode(env().JWT_SECRET);
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Sign a fresh session JWT. Call after a successful login, and to refresh a
 * session (activity, a second factor just set up). The idle limit and whether
 * MFA is required are read from the org each time, so a changed policy
 * reaches a session at its next refresh rather than at its next login.
 */
export async function signSession(
  payload: Session,
  state: { mfa?: boolean; act?: number } = {},
): Promise<string> {
  const policy = await readSessionPolicy(payload.orgId);
  // Only the Session fields: a session refreshed from a decoded token must not
  // carry that token's iat, exp or audience through.
  const body = {
    userId: payload.userId,
    orgId: payload.orgId,
    role: payload.role,
    permissions: payload.permissions,
    email: payload.email,
    sv: SESSION_VERSION,
    act: state.act ?? nowSec(),
    idle: policy.idleMinutes,
    mfa: state.mfa ?? false,
    mfaReq: mfaRequiredFor(payload.role, payload.permissions, policy.mfaPolicy),
  };
  return new SignJWT(body)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(env().JWT_EXPIRES_IN)
    .setIssuer("pallio")
    .setAudience("pallio-app")
    .sign(secret());
}

type TokenPayload = Session & Partial<SessionState> & { sv?: number };

async function readToken(): Promise<TokenPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(env().COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: "pallio",
      audience: "pallio-app",
    });
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Read + verify the session from the request cookie. Returns null if missing,
 * invalid, from before 0121, or past its idle limit.
 */
export async function getSession(): Promise<SignedInSession | null> {
  const p = await readToken();
  if (!p || p.sv !== SESSION_VERSION) return null;
  if (typeof p.act !== "number" || typeof p.idle !== "number") return null;
  if (sessionIsIdle({ act: p.act, idle: p.idle }, nowSec())) return null;
  return { ...p, mfa: p.mfa === true, mfaReq: p.mfaReq === true } as SignedInSession;
}

/**
 * Who a session belonged to, even one past its idle limit — for recording the
 * sign-out on the audit trail, never for access.
 */
export async function readSessionIdentity(): Promise<{ userId: string; orgId: string } | null> {
  const p = await readToken();
  return p ? { userId: p.userId, orgId: p.orgId } : null;
}

/** What a person whose role requires a second factor reads until they set one up. */
export const MFA_SETUP_REQUIRED =
  "Your role signs in with a second factor (an authenticator app). Set it up on Settings → Security to go on.";

/**
 * Guard helper for API route handlers. Throws-by-returning-NextResponse
 * if the caller is not authenticated or lacks the required permissions.
 *
 * A session whose holder must use a second factor and has not set one up
 * reaches only the routes that set one up (allowPendingMfa): everything else
 * answers 403 until they do. It arises when the org's policy changes under a
 * live session, and for a new admin straight after signup or an invite.
 *
 * Usage in a route handler:
 *   export async function GET(req: NextRequest) {
 *     const result = await requireAuth(['billing.lookup.view']);
 *     if (result instanceof NextResponse) return result;
 *     // result is a Session — proceed with business logic.
 *   }
 */
export async function requireAuth(
  requiredPermissions: string[] = [],
  opts: { allowPendingMfa?: boolean } = {},
): Promise<AuthedSession | NextResponse<ApiResponse<null>>> {
  const session = await getSession();
  if (!session) {
    return fail("Not authenticated.", { status: 401 });
  }
  if (session.mfaReq && !session.mfa && !opts.allowPendingMfa) {
    return fail(MFA_SETUP_REQUIRED, { status: 403 });
  }
  if (requiredPermissions.length > 0) {
    const missing = requiredPermissions.filter(
      (perm) => !session.permissions.includes(perm),
    );
    if (missing.length > 0) {
      return fail(`Permission denied: missing ${missing.join(", ")}.`, {
        status: 403,
      });
    }
  }
  return session;
}

/**
 * Convenience for clearing the session cookie (logout). Call this and
 * then redirect or return ok().
 */
export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(env().COOKIE_NAME);
}

/**
 * Set the session cookie on the response. The JWT is in HttpOnly +
 * Secure (in prod) + SameSite=Lax form per OWASP guidance.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(env().COOKIE_NAME, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // 7d in seconds — Next.js cookies API takes maxAge as seconds. The idle
    // limit inside the token ends it far sooner when nobody is using it.
    maxAge: 60 * 60 * 24 * 7,
  });
}
