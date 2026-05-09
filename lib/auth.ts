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
 */
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "./env";
import { fail, type ApiResponse } from "./api";

export type Session = {
  userId: string;
  orgId: string;
  role: "platform_admin" | "org_admin" | "clinician" | "billing_agent" | "consultant" | "analyst" | "read_only";
  permissions: string[];
  email: string;
};

const ALG = "HS256";

function secret(): Uint8Array {
  return new TextEncoder().encode(env().JWT_SECRET);
}

/** Sign a fresh session JWT. Call after a successful login. */
export async function signSession(payload: Session): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(env().JWT_EXPIRES_IN)
    .setIssuer("pallio")
    .setAudience("pallio-app")
    .sign(secret());
}

/** Read + verify the session from the request cookie. Returns null if missing/invalid. */
export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(env().COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: "pallio",
      audience: "pallio-app",
    });
    return payload as unknown as Session;
  } catch {
    return null;
  }
}

/**
 * Guard helper for API route handlers. Throws-by-returning-NextResponse
 * if the caller is not authenticated or lacks the required permissions.
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
): Promise<Session | NextResponse<ApiResponse<null>>> {
  const session = await getSession();
  if (!session) {
    return fail("Not authenticated.", { status: 401 });
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
    // 7d in seconds — Next.js cookies API takes maxAge as seconds.
    maxAge: 60 * 60 * 24 * 7,
  });
}
