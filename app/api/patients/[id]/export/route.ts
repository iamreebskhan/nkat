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
import { logPhiAccess, logPhiExport } from "@/lib/hipaa/phi-access-log";

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
    // phi_export_log is the §164.528 accounting table and is a different
    // record from the line above: audit_log answers "what happened in this
    // org", this answers "what left it, and whose data was in it". The
    // function for it has existed since 0033 with no caller anywhere, so
    // every export so far went unaccounted for.
    await logPhiExport({
      orgId: session.orgId,
      userId: session.userId,
      exportType: "patient_record_pdf",
      patientIds: [id],
      targetUri: `patient-record-${id}.pdf`,
      byteSize: result.pdfBytes.length,
    });
    // An export is also a read of the whole chart, which the access log
    // tracks separately from the disclosure.
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
