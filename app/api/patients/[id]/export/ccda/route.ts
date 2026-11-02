/**
 * GET /api/patients/[id]/export/ccda — the record as a C-CDA R2.1 CCD (0128),
 * for another EHR to import. Permission and logging as the PDF export beside it:
 * a whole chart leaving the building is recorded before the bytes go, with the
 * address it went to.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { recordAuditDetached } from "@/lib/features/audit/audit-write";
import { exportPatientCcd } from "@/lib/features/patients/ccda.service";
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
    const { xml } = await exportPatientCcd({ orgId: session.orgId, userId: session.userId, patientId: id });
    await recordAuditDetached({
      orgId: session.orgId,
      userId: session.userId,
      action: "patient_export",
      targetType: "patient",
      targetId: id,
      payload: { format: "ccda", bytes: Buffer.byteLength(xml) },
      ipAddress: req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    });
    await logPhiAccess({ orgId: session.orgId, userId: session.userId, patientId: id, accessType: "export", context: "patient_ccda", request: req });
    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="patient-ccd-${id}.xml"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
