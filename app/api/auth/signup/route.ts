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

  const result = await signup(body);
  if ("error" in result) {
    const messages: Record<string, string> = {
      email_taken: "An account with that email already exists.",
      org_name_taken: "Organization name is taken — try another.",
      weak_password: "Password must be at least 12 characters.",
      baa_required: "You must accept the Business Associate Agreement.",
    };
    return fail(messages[result.error] ?? "Signup failed.", { status: 422 });
  }

  const token = await signSession(result.session);
  await setSessionCookie(token);
  return ok({ redirectTo: "/onboarding" }, { status: 201 });
}
