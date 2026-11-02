/**
 * PATCH /api/tasks/[id] — change an open task (patients.edit), or close it:
 * done, or cancelled with the reason. The person it is assigned to may close
 * it without patients.edit.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { UpdateTaskSchema } from "@/lib/features/care-coordination/care-coordination.types";
import { updateTask } from "@/lib/features/care-coordination/task.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, UpdateTaskSchema);
  if (body instanceof Response) return body;
  try {
    return ok(
      await updateTask({
        orgId: session.orgId,
        userId: session.userId,
        taskId: id,
        payload: body,
        canEditAny: session.permissions.includes("patients.edit"),
      }),
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
