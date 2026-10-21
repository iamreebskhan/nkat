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
    // org_id as well as user_id, and it is NOT redundant with RLS — the same
    // predicate login() carries, for the same reason. This is the second place
    // in the app that mints a session, and lib/auth.ts requireAuth() gates
    // every route on session.permissions alone, so what comes back here is the
    // user's authority for the whole session.
    // redeemInvite reuses the existing app_user row when the invited address is
    // already on file, so the person accepting a second org's invite routinely
    // holds grants elsewhere; .env.local notes the preview deployment connects
    // as a superuser, which bypasses RLS, and on that connection the query
    // without this line returned all 8 of multi@example.test's grants instead
    // of the 4 held in the org being joined — a grant of team.permissions made
    // in one tenant becoming effective in the other.
    const rows = await tx.$queryRaw<{ permission: string }[]>`
      SELECT permission FROM user_permission
      WHERE user_id = ${result.userId}::uuid
        AND org_id = ${result.orgId}::uuid
      ORDER BY permission
    `;
    return rows.map((r) => r.permission);
  });

  const session: Session = {
    userId: result.userId,
    orgId: result.orgId,
    // The template they were invited with (audit R38), not org_admin for all.
    role: result.roleTemplate,
    permissions,
    email: result.email,
  };
  const sessionToken = await signSession(session);
  await setSessionCookie(sessionToken);

  return ok({ redirectTo: "/", newUser: result.newUser });
}
