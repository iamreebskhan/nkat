/** Replace a member's permission set wholesale. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { setMemberPermissions } from "@/lib/features/team/team.service";

const Body = z.object({
  permissions: z.array(z.string().max(64)).max(80),
});

interface Params {
  params: Promise<{ userId: string }>;
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["team.permissions"]);
  if (session instanceof Response) return session;
  const { userId } = await ctx.params;
  const bad = requireUuidParam(userId);
  if (bad) return bad;
  const body = await parseJson(req, Body);
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
