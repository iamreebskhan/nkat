/**
 * Single patient — GET (read) + PATCH (update).
 */
import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getPatient,
  updatePatient,
} from "@/lib/features/patients/patient.service";
import { UpdatePatientSchema } from "@/lib/features/patients/patient.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const patient = await getPatient({ orgId: session.orgId, id });
  if (!patient) return fail("Patient not found.", { status: 404 });
  return ok(patient);
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, UpdatePatientSchema);
  if (body instanceof Response) return body;

  const { id } = await ctx.params;
  try {
    const r = await updatePatient({ orgId: session.orgId, id, payload: body });
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Update failed", {
      status: 422,
    });
  }
}
