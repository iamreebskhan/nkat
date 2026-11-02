/**
 * POST /api/auth/mfa/enrol/verify { token, code } — confirm the second factor
 * sign-in asked for, and sign in (0121).
 *
 * The first code from the new authenticator confirms it; the session that
 * follows records a second factor, and the recovery codes are answered once.
 * Wrong codes count against the same per-address budget as wrong passwords.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { setSessionCookie, signSession } from "@/lib/auth";
import { recordAuditDetached } from "@/lib/features/audit/audit-write";
import { activeUserById, sessionForUser } from "@/lib/features/auth/auth.service";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  throttleIpOf,
} from "@/lib/features/auth/login-throttle";
import { readEnrolToken } from "@/lib/features/auth/mfa-enrol-token";
import { confirmMfaSetup } from "@/lib/features/auth/mfa.service";
import { prisma } from "@/lib/db";

const Body = z.object({
  token: z.string().min(20).max(2000),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code your authenticator app shows."),
});

export async function POST(req: NextRequest): Promise<Response> {
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  const pass = await readEnrolToken(body.token);
  if (!pass) return fail("This sign-in has expired. Sign in again to set up the second factor.", { status: 401 });

  const ip = throttleIpOf(req.headers);
  const gate = checkLoginAllowed(ip, pass.email);
  if (!gate.allowed) {
    const refused = fail("Too many tries. Wait a little, then sign in again.", { status: 429 });
    refused.headers.set("Retry-After", String(gate.retryAfterSec));
    return refused;
  }

  const r = await confirmMfaSetup({ userId: pass.userId, code: body.code });
  if ("error" in r) {
    if (r.error === "no_pending_setup") return fail("Start the setup again: sign in once more.", { status: 400 });
    recordLoginFailure(ip, pass.email);
    return fail("That code didn't match. Check the app shows Pallio, then enter the current code.", { status: 422 });
  }

  const user = await activeUserById(pass.userId);
  const session = user ? await sessionForUser(user) : null;
  if (!session) return fail("Account is suspended. Contact your org admin.", { status: 403 });

  recordLoginSuccess(ip, pass.email);
  await prisma.$executeRaw`UPDATE app_user SET last_login_at = now() WHERE id = ${pass.userId}::uuid`;
  await setSessionCookie(await signSession(session, { mfa: true }));

  const userAgent = req.headers.get("user-agent");
  void recordAuditDetached({
    orgId: session.orgId, userId: session.userId, action: "mfa_change",
    targetType: "user", targetId: session.userId, payload: { change: "enrolled", via: "login" }, userAgent,
  });
  void recordAuditDetached({ orgId: session.orgId, userId: session.userId, action: "login", payload: {}, userAgent });

  return ok({ recoveryCodes: r.recoveryCodes, redirectTo: "/" });
}
