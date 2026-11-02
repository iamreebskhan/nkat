/**
 * POST /api/auth/mfa/enrol { token } — start setting up the second factor that
 * sign-in asked for (0121).
 *
 * The token is the pass /api/auth/login answered with, for an account whose
 * role requires a second factor and which has none. It names the account; no
 * session exists yet. Answers the secret and the otpauth link to add to an
 * authenticator app.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { readEnrolToken } from "@/lib/features/auth/mfa-enrol-token";
import { setupMfa } from "@/lib/features/auth/mfa.service";

const Body = z.object({ token: z.string().min(20).max(2000) });

export async function POST(req: NextRequest): Promise<Response> {
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  const pass = await readEnrolToken(body.token);
  if (!pass) return fail("This sign-in has expired. Sign in again to set up the second factor.", { status: 401 });
  return ok(await setupMfa({ userId: pass.userId, email: pass.email }));
}
