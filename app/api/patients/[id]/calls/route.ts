/**
 * Telephone encounters (0116; Level-1 doc:52).
 *
 *   GET  — the patient's calls, newest first (patients.view)
 *   POST — record a call (visits.create: clinical documentation). Its symptom
 *          scores are checked against the NP's escalation parameters.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { CreatePhoneEncounterSchema } from "@/lib/features/care-coordination/care-coordination.types";
import { createPhoneEncounter, listPhoneEncounters } from "@/lib/features/care-coordination/phone-encounter.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const rows = await listPhoneEncounters({ orgId: session.orgId, patientId: id });
    void logPhiAccess({
      orgId: session.orgId, userId: session.userId, patientId: id, accessType: "view", context: "phone_encounters", request: req,
    });
    return ok({ rows });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.create"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, CreatePhoneEncounterSchema);
  if (body instanceof Response) return body;
  try {
    const r = await createPhoneEncounter({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
