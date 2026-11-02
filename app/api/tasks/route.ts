/**
 * Tasks to the interdisciplinary team (0116; Level-1 doc:40, :54).
 *
 *   GET  — ?scope=mine (assigned to me) | created (by me) | unassigned (the
 *          disciplines' to pick up; ?discipline=) | patient (?patientId=);
 *          ?status=open|closed|all
 *   POST — create a task (patients.edit). Assigning it tells that person.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, handleServiceError, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { CreateTaskSchema } from "@/lib/features/care-coordination/care-coordination.types";
import { createTask, listTasks, type TaskScope } from "@/lib/features/care-coordination/task.service";
import { DISCIPLINES } from "@/lib/features/care-plans/care-plan.types";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

const Query = z.object({
  scope: z.enum(["mine", "created", "unassigned", "patient"]).default("mine"),
  patientId: z.string().uuid().optional(),
  discipline: z.enum(DISCIPLINES).optional(),
  status: z.enum(["open", "closed", "all"]).default("open"),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const q = parseSearchParams(new URL(req.url), Query);
  if (q instanceof Response) return q;
  // Your own tasks are yours to see; anyone else's are the chart's.
  const own = q.scope === "mine" || q.scope === "created";
  if (!own && !session.permissions.includes("patients.view")) return fail("Permission denied.", { status: 403 });
  let scope: TaskScope;
  if (q.scope === "patient") {
    if (!q.patientId) return fail("Which patient?", { status: 400 });
    scope = { kind: "patient", patientId: q.patientId };
  } else if (q.scope === "unassigned") scope = { kind: "unassigned", discipline: q.discipline };
  else if (q.scope === "created") scope = { kind: "created", userId: session.userId };
  else scope = { kind: "assigned", userId: session.userId };
  try {
    const r = await listTasks({ orgId: session.orgId, scope, status: q.status });
    if (scope.kind === "patient") {
      void logPhiAccess({
        orgId: session.orgId, userId: session.userId, patientId: scope.patientId, accessType: "view",
        context: "care_tasks", request: req,
      });
    }
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, CreateTaskSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await createTask({ orgId: session.orgId, userId: session.userId, payload: body }), { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
