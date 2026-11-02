/**
 * POST /api/patients/[id]/clinical-lists/[list] — add to the chart's
 * problems, medications or allergies (0114), or, as
 * /clinical-lists/no-known-allergies, record that the patient has none.
 *
 * Writing to the chart's lists takes patients.edit, as the chart's other
 * cards do.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  addAllergy,
  addMedication,
  addProblem,
  setNoKnownAllergies,
} from "@/lib/features/clinical/clinical-lists.service";
import {
  AddAllergySchema,
  AddMedicationSchema,
  AddProblemSchema,
} from "@/lib/features/clinical/clinical-lists.types";

interface Params {
  params: Promise<{ id: string; list: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id, list } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const who = { orgId: session.orgId, userId: session.userId, patientId: id };
  try {
    switch (list) {
      case "problems": {
        const body = await parseJson(req, AddProblemSchema);
        if (body instanceof Response) return body;
        return ok(await addProblem({ ...who, payload: body }), { status: 201 });
      }
      case "medications": {
        const body = await parseJson(req, AddMedicationSchema);
        if (body instanceof Response) return body;
        return ok(await addMedication({ ...who, payload: body }), { status: 201 });
      }
      case "allergies": {
        const body = await parseJson(req, AddAllergySchema);
        if (body instanceof Response) return body;
        return ok(await addAllergy({ ...who, payload: body }), { status: 201 });
      }
      case "no-known-allergies":
        await setNoKnownAllergies(who);
        return ok({ recorded: true });
      default:
        return fail("Unknown list.", { status: 404 });
    }
  } catch (err) {
    return handleServiceError(err);
  }
}
