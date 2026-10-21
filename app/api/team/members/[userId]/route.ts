/** Replace a member's permission set wholesale. */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { setMemberPermissions } from "@/lib/features/team/team.service";
// Straight from the module that DEFINES the schema, not through the service's
// re-export. A route spec has to stub the service (it opens a tx), and a stub
// stands in for the re-export too: deleting MemberPermissionsSchema from
// team.service left this route calling parseJson(req, undefined) — a 500 on
// every save — with the route spec still green.
import { MemberPermissionsSchema } from "@/lib/features/team/team.types";

interface Params {
  params: Promise<{ userId: string }>;
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["team.permissions"]);
  if (session instanceof Response) return session;
  const { userId } = await ctx.params;
  const bad = requireUuidParam(userId);
  if (bad) return bad;
  // The invite path's schema, not a private copy of it. The copy that used to
  // live here had no minimum, so unticking every permission and saving was
  // accepted and the member lost every grant in one request.
  const body = await parseJson(req, MemberPermissionsSchema);
  if (body instanceof Response) return body;
  try {
    const r = await setMemberPermissions({
      orgId: session.orgId,
      userId,
      permissions: body.permissions,
      grantedByUserId: session.userId,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
