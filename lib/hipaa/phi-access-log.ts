/**
 * PHI access log helpers.
 *
 * HIPAA Privacy Rule 45 CFR §164.528 (Accounting of Disclosures) +
 * Security Rule §164.312(b) (Audit Controls). Every read of an
 * identified patient row is recorded.
 *
 * Call from inside the route handler AFTER the read succeeded:
 *
 *   const patient = await getPatient(...);
 *   await logPhiAccess({ orgId, userId, patientId, accessType: 'view',
 *                        context: 'patient_record', request });
 *
 * Insert is best-effort fire-and-forget — a logging failure must not
 * 5xx the user. We surface the failure to stderr + a Sentry breadcrumb;
 * if logging is permanently broken, on-call wakes from the daily
 * "phi_access_log inserts" SLO panel.
 */
import type { NextRequest } from "next/server";

import { withOrgContext } from "@/lib/db";

export type PhiAccessType = "view" | "edit" | "export" | "print" | "api_read";

export interface PhiAccessParams {
  orgId: string;
  userId: string;
  patientId: string;
  accessType: PhiAccessType;
  context?: string;
  reason?: string;
  request?: NextRequest;
}

export async function logPhiAccess(params: PhiAccessParams): Promise<void> {
  const { orgId, userId, patientId, accessType, context, reason, request } = params;
  const ip = request ? readIp(request) : null;
  const ua = request?.headers.get("user-agent") ?? null;

  try {
    await withOrgContext(orgId, async (tx) => {
      await tx.$executeRaw`
        SELECT log_phi_access(
          ${userId}::uuid,
          ${patientId}::uuid,
          ${accessType},
          ${context ?? null},
          ${reason ?? null},
          ${ip}::inet,
          ${ua}
        )
      `;
    });
  } catch (err) {
    // Logging failures must not break the caller. Surface for ops.
    console.error("phi_access_log insert failed", {
      err: err instanceof Error ? err.message : String(err),
      orgId,
      patientId,
      accessType,
    });
  }
}

export interface PhiExportParams {
  orgId: string;
  userId: string;
  exportType:
    | "cheat_sheet"
    | "superbill_pdf"
    | "report_csv"
    | "patient_record_pdf"
    | "rule_lookup_pdf";
  patientIds?: string[];
  targetUri?: string;
  byteSize?: number;
}

export async function logPhiExport(params: PhiExportParams): Promise<void> {
  const { orgId, userId, exportType, patientIds, targetUri, byteSize } = params;
  try {
    await withOrgContext(orgId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO phi_export_log (
          org_id, user_id, export_type, target_uri, byte_size, patient_ids
        ) VALUES (
          ${orgId}::uuid, ${userId}::uuid, ${exportType},
          ${targetUri ?? null}, ${byteSize ?? null},
          ${patientIds ?? []}::uuid[]
        )
      `;
    });
  } catch (err) {
    console.error("phi_export_log insert failed", {
      err: err instanceof Error ? err.message : String(err),
      orgId,
      exportType,
    });
  }
}

function readIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? null;
}
