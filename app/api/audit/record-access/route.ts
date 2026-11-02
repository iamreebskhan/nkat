/**
 * GET /api/audit/record-access — who opened or exported a patient's record.
 * `audit.view`, as the audit log itself. See record-access.service.ts.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listRecordAccess, RECORD_ACCESS_CURSOR } from "@/lib/features/audit/record-access.service";

const Query = z.object({
  patientId: z.string().uuid().transform((s) => s.toLowerCase()).optional(),
  userEmail: z.string().email().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().regex(RECORD_ACCESS_CURSOR).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["audit.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const result = await listRecordAccess({
    orgId: session.orgId,
    patientId: params.patientId,
    userEmail: params.userEmail,
    fromDate: params.fromDate ? new Date(`${params.fromDate}T00:00:00Z`) : undefined,
    toDate: params.toDate ? new Date(`${params.toDate}T23:59:59Z`) : undefined,
    cursor: params.cursor,
    limit: params.limit,
  });
  return ok(result);
}
