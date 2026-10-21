/** DELETE /api/time-off/[id] — remove a PTO entry. */
import { type NextRequest } from "next/server";

import { ok, fail, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { deleteTimeOff } from "@/lib/features/schedule/time-off.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<Response> {
  // schedule.edit is a way IN to this handler, not a claim on a particular
  // row: the clinician template carries it so they can drag their own visits
  // on the week grid, so it admits precisely the caller the boundary below
  // exists to constrain. deleteTimeOff decides whose leave this is, because it
  // is the only layer that can see the row — and because it must write the
  // audit entry in the same transaction as the delete.
  const session = await requireAuth(["schedule.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const r = await deleteTimeOff({
    orgId: session.orgId,
    id,
    callerUserId: session.userId,
    callerPermissions: session.permissions,
  });
  // 403 before 404: the row exists and the answer is about the caller, not
  // about the row. A caller who may not touch it is told nothing more.
  if (r.refusedReason) return fail(r.refusedReason, { status: 403 });
  if (!r.deleted) return fail("Not found.", { status: 404 });
  return ok({ deleted: true });
}
