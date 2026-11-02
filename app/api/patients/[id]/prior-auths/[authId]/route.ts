/** A prior authorization (0124) — PATCH (correct) + DELETE (withdraw, as recorded in error; the row stays). */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { PriorAuthSchema, updatePriorAuth, withdrawPriorAuth } from "@/lib/features/patients/prior-auth.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string; authId: string }>;
}

const WRITE_ANY = ["patients.edit", "billing.superbills.edit"];

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!WRITE_ANY.some((p) => session.permissions.includes(p))) return fail("Permission denied.", { status: 403 });
  const { id, authId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(authId);
  if (bad) return bad;
  const body = await parseJson(req, PriorAuthSchema);
  if (body instanceof Response) return body;
  try {
    await updatePriorAuth({ orgId: session.orgId, userId: session.userId, patientId: id, authId, input: body });
    void logPhiAccess({ orgId: session.orgId, userId: session.userId, patientId: id, accessType: "edit", context: "patient_prior_auths", request: req });
    return ok({ updated: true });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function DELETE(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!WRITE_ANY.some((p) => session.permissions.includes(p))) return fail("Permission denied.", { status: 403 });
  const { id, authId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(authId);
  if (bad) return bad;
  try {
    await withdrawPriorAuth({ orgId: session.orgId, userId: session.userId, patientId: id, authId });
    void logPhiAccess({ orgId: session.orgId, userId: session.userId, patientId: id, accessType: "edit", context: "patient_prior_auths", request: req });
    return ok({ withdrawn: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
