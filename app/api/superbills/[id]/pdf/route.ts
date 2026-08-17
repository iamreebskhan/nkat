/** GET /api/superbills/[id]/pdf — branded superbill PDF. */
import { type NextRequest } from "next/server";

import { handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { generateSuperbillPdf } from "@/lib/features/superbills/superbill-pdf.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

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
    // NOTE: phi_export_log is written by generateSuperbillPdf() itself — do
    // not add a second call here, or one download becomes two disclosures in
    // the §164.528 accounting.
    //
    // The access log was the genuinely missing half: this PDF carries the
    // patient's name, date of birth and member id, and nothing recorded that
    // it had been read.
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
