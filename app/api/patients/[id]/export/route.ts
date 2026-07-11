/**
 * GET /api/patients/[id]/export — HIPAA right-of-access PDF.
 *
 * Permission: patients.view (org admin / clinician of record).
 * Patient self-portal access is a Phase 11 item — for now this is the
 * org-side fulfilment endpoint.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getBranding } from "@/lib/features/branding/branding.service";
import { exportPatientRecord } from "@/lib/features/patients/patient-export.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  try {
    const branding = await getBranding(session.orgId);
    const result = await exportPatientRecord({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      orgName: branding.displayName ?? "Pallio",
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
    });
    return new Response(new Uint8Array(result.pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="patient-record-${id}.pdf"`,
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
