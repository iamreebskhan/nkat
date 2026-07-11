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

const Schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  mfaCode: z.string().max(20).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  const result = await login({
    email: body.email,
    password: body.password,
    mfaCode: body.mfaCode,
  });
  if ("error" in result) {
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

