/** DELETE /api/time-off/[id] — remove a PTO entry. */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { deleteTimeOff } from "@/lib/features/schedule/time-off.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["schedule.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const r = await deleteTimeOff({ orgId: session.orgId, id });
  if (!r.deleted) return fail("Not found.", { status: 404 });
  return ok(r);
}
