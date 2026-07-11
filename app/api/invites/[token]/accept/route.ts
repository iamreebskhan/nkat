/** POST — accept the invite (no auth required; the token IS the auth). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson } from "@/lib/api";
import { setSessionCookie, signSession, type Session } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { redeemInvite } from "@/lib/features/team/invite-redeem.service";

const Body = z.object({
  fullName: z.string().min(1).max(120),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(200)
    .optional(),
});

interface Params {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const { token } = await ctx.params;
  if (!/^[a-f0-9]{48}$/i.test(token)) {
    return fail("Invalid invite token format.", { status: 400 });
  }
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  const result = await redeemInvite({ token, fullName: body.fullName, password: body.password });
  if ("error" in result) {
    if (result.error === "needs_password") {
      return fail("This is a new account — supply a password (min 12 chars).", { status: 422 });
    }
    return fail("Invite expired or invalid.", { status: 410 });
  }

  // Hydrate the session with the user's org permissions and sign in.
  const permissions = await withOrgContext(result.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ permission: string }[]>`
      SELECT permission FROM user_permission
      WHERE user_id = ${result.userId}::uuid
      ORDER BY permission
    `;
    return rows.map((r) => r.permission);
  });

  const session: Session = {
    userId: result.userId,
    orgId: result.orgId,
    role: "org_admin",
    permissions,
    email: result.email,
  };
  const sessionToken = await signSession(session);
  await setSessionCookie(sessionToken);

  return ok({ redirectTo: "/", newUser: result.newUser });
}
