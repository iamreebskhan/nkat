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
import { recordAuditDetached } from "@/lib/features/audit/audit-write";
import { getBranding } from "@/lib/features/branding/branding.service";
import { exportPatientRecord } from "@/lib/features/patients/patient-export.service";
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
    const branding = await getBranding(session.orgId);
    const result = await exportPatientRecord({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      orgName: branding.displayName ?? "Pallio",
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
    });
    // A whole chart in one file, leaving the building. Of everything in this
    // app this is the event most worth being able to answer for later, so the
    // row is written BEFORE the bytes are handed over — and it carries the
    // address it went to, because "who exported it" without "to where" only
    // answers half the question.
    await recordAuditDetached({
      orgId: session.orgId,
      userId: session.userId,
      action: "patient_export",
      targetType: "patient",
      targetId: id,
      payload: { format: "pdf", bytes: result.pdfBytes.length },
      ipAddress: req.headers.get("x-real-ip")
        ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        ?? null,
      userAgent: req.headers.get("user-agent"),
    });
    // NOTE: phi_export_log is written by exportPatientRecord() itself — do
    // not add a second call here. It is the §164.528 accounting table, and
    // two rows for one download would overstate the disclosures.
    //
    // The access log is a different record and was genuinely missing: an
    // export is also a read of the whole chart, and nothing recorded that.
    await logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "export",
      context: "patient_record_pdf",
      request: req,
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
