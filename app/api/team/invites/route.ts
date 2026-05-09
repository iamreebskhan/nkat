/** Team invites: POST creates invite + permission rows in a tx. GET lists pending. */
import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  InviteSchema,
  createInvite,
  listInvites,
} from "@/lib/features/team/team.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["team.view"]);
  if (session instanceof Response) return session;
  const rows = await listInvites({ orgId: session.orgId });
  return ok({ rows, total: rows.length });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["team.invite", "team.permissions"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, InviteSchema);
  if (body instanceof Response) return body;
  try {
    const r = await createInvite({
      orgId: session.orgId,
      invitedByUserId: session.userId,
      payload: body,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Invite failed", { status: 422 });
  }
}
