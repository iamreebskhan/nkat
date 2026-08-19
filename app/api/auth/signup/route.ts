/**
 * POST /api/auth/signup — self-serve org signup with inline BAA.
 *
 * Body: { email, password, fullName, orgName, baaAccepted }
 *
 * Creates org + admin user + permissions transactionally per
 * pallio_complete_vision_v3 §6.2.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson } from "@/lib/api";
import { setSessionCookie, signSession } from "@/lib/auth";
import { signup } from "@/lib/features/auth/auth.service";
import {
  checkSignupAllowed,
  recordSignupAttempt,
} from "@/lib/features/auth/login-throttle";

const Schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12, "Password must be at least 12 characters").max(200),
  fullName: z.string().min(1).max(120),
  orgName: z.string().min(2).max(120),
  baaAccepted: z.boolean(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  // Signup answers "is this address registered?" honestly, which is
  // enumeration. Capping the volume is what takes the value out of it — one
  // address is a curiosity, ten thousand is a mailing list — without making
  // the form lie to a customer who mistyped their own email. Counted per
  // attempt, not per failure, because a probe looks like a valid request.
  const ip = readSignupIp(req);
  const gate = checkSignupAllowed(ip);
  if (!gate.allowed) {
    const refused = fail("Too many signup attempts. Try again shortly.", { status: 429 });
    refused.headers.set("Retry-After", String(gate.retryAfterSec));
    return refused;
  }
  recordSignupAttempt(ip);

  const result = await signup(body);
  if ("error" in result) {
    const messages: Record<string, string> = {
      email_taken: "An account with that email already exists.",
      org_name_taken: "Organization name is taken — try another.",
      weak_password: "Password must be at least 12 characters.",
      baa_required: "You must accept the Business Associate Agreement.",
    };
    // The policy says WHICH rule failed; prefer that over the generic line.
    // Telling someone "must be at least 12 characters" about a 16-character
    // password they just typed is how a form gets abandoned.
    const reason = "reason" in result ? result.reason : undefined;
    return fail(reason ?? messages[result.error] ?? "Signup failed.", { status: 422 });
  }

  const token = await signSession(result.session);
  await setSessionCookie(token);
  return ok({ redirectTo: "/onboarding" }, { status: 201 });
}

/**
 * Client address for throttling — X-Real-IP first, then the LAST forwarded
 * hop. Same reasoning as the login route: nginx appends the real peer to
 * whatever the client sent, so the FIRST X-Forwarded-For entry is attacker
 * chosen and a limiter keyed on it is bypassed with one extra header.
 */
function readSignupIp(req: NextRequest): string | null {
  const real = req.headers.get("x-real-ip");
  if (real?.trim()) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]!;
  }
  return null;
}
