/**
 * A patient's prior authorizations (0124) — GET (list, with the plans on the
 * chart) + POST (add). Whoever edits the chart or the bill records them.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { PriorAuthSchema, addPriorAuth, listPriorAuths } from "@/lib/features/patients/prior-auth.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

const WRITE_ANY = ["patients.edit", "billing.superbills.edit"];

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const r = await listPriorAuths({ orgId: session.orgId, patientId: id });
    void logPhiAccess({ orgId: session.orgId, userId: session.userId, patientId: id, accessType: "view", context: "patient_prior_auths", request: req });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!WRITE_ANY.some((p) => session.permissions.includes(p))) return fail("Permission denied.", { status: 403 });
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, PriorAuthSchema);
  if (body instanceof Response) return body;
  try {
    const r = await addPriorAuth({ orgId: session.orgId, userId: session.userId, patientId: id, input: body });
    void logPhiAccess({ orgId: session.orgId, userId: session.userId, patientId: id, accessType: "edit", context: "patient_prior_auths", request: req });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
