/** GET /api/superbills/[id]/pdf — branded superbill PDF. */
import { type NextRequest } from "next/server";

import { handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { generateSuperbillPdf } from "@/lib/features/superbills/superbill-pdf.service";
import { logPhiAccess, logPhiExport } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.export"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const { pdfBytes, superbill } = await generateSuperbillPdf({
      orgId: session.orgId,
      userId: session.userId,
      superbillId: id,
    });
    // This PDF carries the patient's name, date of birth and member id to
    // whoever downloads it. It was leaving with no record on either log —
    // the superbill is the document that goes to the payer, so it is the
    // disclosure most likely to be asked about.
    await logPhiExport({
      orgId: session.orgId,
      userId: session.userId,
      exportType: "superbill_pdf",
      patientIds: [superbill.patient_id],
      targetUri: `superbill-${id}.pdf`,
      byteSize: pdfBytes.length,
    });
    await logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: superbill.patient_id,
      accessType: "export",
      context: "superbill_pdf",
      request: req,
    });
    return new Response(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="superbill-${id}.pdf"`,
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
