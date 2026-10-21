/**
 * A patient's family and caregivers (audit R30) — GET (list) + POST (add).
 *
 * The chart held one unlabelled emergency-contact pair that nothing read back.
 * These are the rows the chart's Family & caregivers card edits; the note
 * header prints the healthcare POA and primary caregiver from them.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { createContact, listContacts } from "@/lib/features/patients/contacts.service";
import { PatientContactSchema } from "@/lib/features/patients/contacts.types";
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
    const rows = await listContacts({ orgId: session.orgId, patientId: id });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "view",
      context: "patient_contacts",
      request: req,
    });
    return ok({ rows });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, PatientContactSchema);
  if (body instanceof Response) return body;
  try {
    const contact = await createContact({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      input: body,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "edit",
      context: "patient_contacts",
      request: req,
    });
    return ok(contact, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
