/**
 * POST /api/auth/login — DB-backed login.
 *
 * 1. Validate body
 * 2. login() service: bcrypt-verify, load org_member + permissions
 * 3. Sign + set session cookie
 * 4. ok({ redirectTo: '/' })
 *
 * Audit: every successful login writes an audit_log row.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson } from "@/lib/api";
import { setSessionCookie, signSession } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { login } from "@/lib/features/auth/auth.service";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/features/auth/login-throttle";

const Schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  mfaCode: z.string().max(20).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  // Checked BEFORE login(), so a guessing run never reaches bcrypt and cannot
  // use this endpoint as a CPU sink either.
  const throttleIp = readThrottleIp(req);
  const gate = checkLoginAllowed(throttleIp, body.email);
  if (!gate.allowed) {
    // fail() keeps the body identical to every other error on this API; the
    // header is set on the response it returns rather than by widening the
    // helper's signature for one caller.
    const refused = fail("Too many sign-in attempts. Try again shortly.", { status: 429 });
    refused.headers.set("Retry-After", String(gate.retryAfterSec));
    return refused;
  }

  const result = await login({
    email: body.email,
    password: body.password,
    mfaCode: body.mfaCode,
  });
  if ("error" in result) {
    // A suspended account is not a wrong guess; counting it would let a
    // known-suspended address burn the budget of everyone behind that IP.
    if (result.error !== "user_inactive") {
      recordLoginFailure(throttleIp, body.email);
    }
    if (result.error === "mfa_required") {
      return fail("MFA code required.", { status: 401 });
    }
    if (result.error === "mfa_bad_code") {
      return fail("MFA code didn't match.", { status: 401 });
    }
    if (result.error === "user_inactive") {
      return fail("Account is suspended. Contact your org admin.", { status: 403 });
    }
    return fail("Invalid email or password.", { status: 401 });
  }

  // A correct password is proof this is not a guessing run: clear the budget
  // so four fat-fingered attempts followed by the right one costs nothing.
  recordLoginSuccess(throttleIp, body.email);

  const token = await signSession(result.session);
  await setSessionCookie(token);

  // Audit log — fire-and-forget so a logging hiccup doesn't 5xx the user.
  void writeLoginAudit(req, result.session.orgId, result.session.userId).catch(() => undefined);

  return ok({ redirectTo: "/" });
}

async function writeLoginAudit(
  req: NextRequest,
  orgId: string,
  userId: string,
): Promise<void> {
  const ip = readIp(req);
  const ua = req.headers.get("user-agent");
  await withOrgContext(orgId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO audit_log (org_id, user_id, action, payload, ip_address, user_agent)
      VALUES (${orgId}::uuid, ${userId}::uuid, 'login', '{}'::jsonb, ${ip}::inet, ${ua})
    `;
  });
}

function readIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? null;
}

/**
 * The client address for THROTTLING, which is not the same question readIp
 * above answers.
 *
 * readIp takes the FIRST X-Forwarded-For entry, which is the right convention
 * for an audit trail and the wrong one for a rate limiter: nginx APPENDS the
 * real peer to whatever the client sent, so the first entry is a string the
 * caller chose. A limiter keyed on it is bypassed by putting a random value
 * in the header on every request — which costs an attacker one line.
 *
 * So: X-Real-IP first (nginx sets it from $remote_addr and a client cannot
 * forge it through the proxy), and otherwise the LAST forwarded entry, which
 * is the one our own edge appended.
 */
function readThrottleIp(req: NextRequest): string | null {
  const real = req.headers.get("x-real-ip");
  if (real?.trim()) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]!;
  }
  return null;
}

