/**
 * PATCH /api/patients/[id]/clinical-lists/[list]/[itemId] — correct an entry
 * on the chart's problems, medications or allergies, or resolve, stop,
 * inactivate or reopen it (0114). Tri-state: absent keeps, null clears.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  updateAllergy,
  updateMedication,
  updateProblem,
} from "@/lib/features/clinical/clinical-lists.service";
import {
  UpdateAllergySchema,
  UpdateMedicationSchema,
  UpdateProblemSchema,
} from "@/lib/features/clinical/clinical-lists.types";

interface Params {
  params: Promise<{ id: string; list: string; itemId: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id, list, itemId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(itemId);
  if (bad) return bad;
  const who = { orgId: session.orgId, userId: session.userId, patientId: id, itemId };
  try {
    switch (list) {
      case "problems": {
        const body = await parseJson(req, UpdateProblemSchema);
        if (body instanceof Response) return body;
        return ok(await updateProblem({ ...who, payload: body }));
      }
      case "medications": {
        const body = await parseJson(req, UpdateMedicationSchema);
        if (body instanceof Response) return body;
        return ok(await updateMedication({ ...who, payload: body }));
      }
      case "allergies": {
        const body = await parseJson(req, UpdateAllergySchema);
        if (body instanceof Response) return body;
        return ok(await updateAllergy({ ...who, payload: body }));
      }
      default:
        return fail("Unknown list.", { status: 404 });
    }
  } catch (err) {
    return handleServiceError(err);
  }
}
