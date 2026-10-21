/**
 * GET /api/visits/[id]/audit-packet — the signed note and its superbill in one
 * PDF, with the note-against-bill reconciliation already done.
 *
 * This is the artefact Mark Hendrix described on 20 Aug 2026 [10:48]: "the
 * audit tool that you need for each visit is that note and — and the superbill."
 *
 * Permissions: this hands out a document containing the full clinical note AND
 * the claim, so it needs both sides. A billing agent has no clinical read in
 * the shipped role templates and must not acquire one through an export route.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { generateAuditPacketPdf } from "@/lib/features/visits/audit-packet.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

const CLINICAL_READ = ["visits.view.all", "visits.view.own", "visits.edit"];

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.export"]);
  if (session instanceof Response) return session;
  if (!CLINICAL_READ.some((p) => session.permissions.includes(p))) {
    return fail(
      "This packet contains the clinical note as well as the claim, so it needs visit access in addition to the export permission.",
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // "visit access" above means a permission, which is not the same as a claim
  // on THIS visit. Checked before the PDF is built so a refusal never writes a
  // §164.528 export row for a document that was never handed over.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  try {
    const { pdfBytes, patientId } = await generateAuditPacketPdf({
      orgId: session.orgId,
      userId: session.userId,
      visitId: id,
    });
    // phi_export_log is written inside generateAuditPacketPdf. Only the ACCESS
    // log belongs here — writing the export log twice would turn one download
    // into two disclosures in the §164.528 accounting.
    await logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId,
      accessType: "export",
      context: "visit_audit_packet",
      request: req,
    });
    return new Response(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="audit-packet-${id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
