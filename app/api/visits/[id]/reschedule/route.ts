/** PATCH /api/visits/[id]/reschedule — drag-to-reschedule on the grid. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { rescheduleVisit } from "@/lib/features/visits/visit.service";

const Body = z.object({
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime().nullable().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["schedule.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    const r = await rescheduleVisit({
      orgId: session.orgId,
      id,
      scheduledStart: body.scheduledStart,
      scheduledEnd: body.scheduledEnd ?? null,
    });
    if (!r.updated) return fail("Visit not found or not reschedulable.", { status: 404 });
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Reschedule failed", { status: 422 });
  }
}
