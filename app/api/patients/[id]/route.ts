/**
 * Single patient — GET (read) + PATCH (update).
 */
import { type NextRequest } from "next/server";

import { NotFoundError, fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getPatient,
  updatePatient,
} from "@/lib/features/patients/patient.service";
import { UpdatePatientSchema } from "@/lib/features/patients/patient.types";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const patient = await getPatient({ orgId: session.orgId, id });
  if (!patient) return fail("Patient not found.", { status: 404 });
  void logPhiAccess({
    orgId: session.orgId,
    userId: session.userId,
    patientId: id,
    accessType: "view",
    context: "patient_record",
    request: req,
  });
  return ok(patient);
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, UpdatePatientSchema);
  if (body instanceof Response) return body;

  // Acuity is a clinical judgement — gate it on the finer-grained
  // patient.acuity.edit permission (clinician + org_admin have it).
  if (body.clinical?.acuity && !session.permissions.includes("patient.acuity.edit")) {
    return fail("patient.acuity.edit permission required to change acuity.", {
      status: 403,
    });
  }

  // Care-team assignment gates on a PERMISSION (roles are display-only per
  // lib/auth.ts); org_admin templates carry patients.careteam.edit (0055
  // backfills existing admins). platform_admin is the operator override —
  // the established primitive for that role (0039).
  if (
    body.careTeam &&
    Object.keys(body.careTeam).length > 0 &&
    !session.permissions.includes("patients.careteam.edit") &&
    session.role !== "platform_admin"
  ) {
    return fail("patients.careteam.edit permission required to change care-team assignments.", {
      status: 403,
    });
  }

  const { id } = await ctx.params;
  try {
    const r = await updatePatient({
      orgId: session.orgId,
      id,
      payload: body,
      userId: session.userId,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "edit",
      context: "patient_record",
      request: req,
    });
    return ok(r);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(err.message, { status: 404 });
    return fail(err instanceof Error ? err.message : "Update failed", {
      status: 422,
    });
  }
}
