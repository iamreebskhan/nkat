/**
 * POST /api/patients/[id]/care-management/charges — raise a month's PCM/CCM
 * charge (0117; Level-1 doc:69). visits.submit, the grant that sends a signed
 * visit to billing, and the service also wants a practitioner's credential. A
 * signed visit on the reserved month type carries the charge, and its draft
 * bill is raised as sign-off raises one: the outcome is returned.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { RaiseChargeSchema } from "@/lib/features/care-coordination/care-management";
import { raiseCharge } from "@/lib/features/care-coordination/care-management.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.submit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, RaiseChargeSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await raiseCharge({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body }), {
      status: 201,
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
