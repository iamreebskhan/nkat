/**
 * The short-lived pass that lets a person set up a second factor during
 * sign-in (0121), when their role requires one and they have none yet.
 *
 * It is not a session: it opens only the two routes that set up the
 * authenticator (mfa/enrol), names the account whose password was just
 * checked, and lasts ten minutes. A separate audience keeps it from ever being
 * read as a session token, and a session token from being read as one of
 * these.
 */
import { SignJWT, jwtVerify } from "jose";

import { env } from "@/lib/env";

const AUDIENCE = "pallio-mfa-enrol";
const LIFETIME = "10m";

export interface EnrolPass {
  userId: string;
  orgId: string;
  email: string;
}

function secret(): Uint8Array {
  return new TextEncoder().encode(env().JWT_SECRET);
}

export async function signEnrolToken(p: EnrolPass): Promise<string> {
  return new SignJWT({ userId: p.userId, orgId: p.orgId, email: p.email, purpose: "mfa_enrol" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(LIFETIME)
    .setIssuer("pallio")
    .setAudience(AUDIENCE)
    .sign(secret());
}

/** The account the pass was issued for; null when it is expired, altered or not a pass. */
export async function readEnrolToken(token: string): Promise<EnrolPass | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: "pallio", audience: AUDIENCE });
    if (payload.purpose !== "mfa_enrol") return null;
    const { userId, orgId, email } = payload as Record<string, unknown>;
    if (typeof userId !== "string" || typeof orgId !== "string" || typeof email !== "string") return null;
    return { userId, orgId, email };
  } catch {
    return null;
  }
}
