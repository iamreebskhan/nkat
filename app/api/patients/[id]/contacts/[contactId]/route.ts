/**
 * One family member or caregiver (audit R30) — PATCH (edit) + DELETE.
 *
 * PATCH is tri-state per optional field: absent keeps, null clears. Both are
 * scoped to the patient in the URL, so a contact id from another chart is a
 * 404, never an edit.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { deleteContact, updateContact } from "@/lib/features/patients/contacts.service";
import { UpdatePatientContactSchema } from "@/lib/features/patients/contacts.types";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string; contactId: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id, contactId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(contactId);
  if (bad) return bad;
  const body = await parseJson(req, UpdatePatientContactSchema);
  if (body instanceof Response) return body;
  try {
    const contact = await updateContact({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      contactId,
      patch: body,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "edit",
      context: "patient_contacts",
      request: req,
    });
    return ok(contact);
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function DELETE(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id, contactId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(contactId);
  if (bad) return bad;
  try {
    const r = await deleteContact({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      contactId,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "edit",
      context: "patient_contacts",
      request: req,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
