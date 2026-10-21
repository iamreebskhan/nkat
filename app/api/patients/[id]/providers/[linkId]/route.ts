/**
 * DELETE /api/patients/[id]/providers/[linkId] — unlink an outside provider
 * from a patient (audit R30). Unlinks only: the roster row stays for every
 * other patient that links it.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { unlinkPatientProvider } from "@/lib/features/patients/external-providers.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string; linkId: string }>;
}

export async function DELETE(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id, linkId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(linkId);
  if (bad) return bad;
  try {
    const r = await unlinkPatientProvider({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      linkId,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "edit",
      context: "patient_providers",
      request: req,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
