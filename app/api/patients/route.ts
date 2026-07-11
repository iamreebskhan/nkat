/**
 * Patients collection — GET (list/search) + POST (create).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  createPatient,
  listPatients,
  searchPatients,
} from "@/lib/features/patients/patient.service";
import {
  CreatePatientSchema,
  PATIENT_STATUSES,
} from "@/lib/features/patients/patient.types";

const ListSchema = z.object({
  search: z.string().min(1).max(100).optional(),
  status: z.enum(PATIENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["patients.list"]);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const params = parseSearchParams(url, ListSchema);
  if (params instanceof Response) return params;

  if (params.search) {
    const rows = await searchPatients({
      orgId: session.orgId,
      query: params.search,
      // Without this, the status filter was silently ignored during search —
      // discharged/deceased patients were unfindable by name.
      status: params.status,
      limit: params.limit,
    });
    return ok({ rows, total: rows.length });
  }

  const result = await listPatients({
    orgId: session.orgId,
    status: params.status,
    limit: params.limit,
    offset: params.offset,
  });
  return ok(result);
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["patients.create"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, CreatePatientSchema);
  if (body instanceof Response) return body;

  // Same gate as PATCH: care-team assignment needs patients.careteam.edit
  // (roles are display-only; platform_admin is the operator override). The
  // intake wizard hides the selects from users without the permission, so
  // this only blocks deliberate API calls.
  if (
    Object.keys(body.careTeam).length > 0 &&
    !session.permissions.includes("patients.careteam.edit") &&
    session.role !== "platform_admin"
  ) {
    return fail("patients.careteam.edit permission required to assign the care team.", { status: 403 });
  }

  try {
    const result = await createPatient({
      orgId: session.orgId,
      createdByUserId: session.userId,
      payload: body,
    });
    return ok(result, { status: 201 });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Create failed", { status: 422 });
  }
}
