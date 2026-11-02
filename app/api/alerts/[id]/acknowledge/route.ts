/**
 * POST /api/alerts/[id]/acknowledge — the NP has seen an escalation alert
 * (0116; Level-1 doc:57), with an optional note. careplans.edit: the people
 * who keep the plan the alert came from.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { AcknowledgeAlertSchema } from "@/lib/features/care-coordination/care-coordination.types";
import { acknowledgeAlert } from "@/lib/features/care-coordination/escalation.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, AcknowledgeAlertSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await acknowledgeAlert({ orgId: session.orgId, userId: session.userId, alertId: id, note: body.note }));
  } catch (err) {
    return handleServiceError(err);
  }
}
