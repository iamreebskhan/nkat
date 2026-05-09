/** Audit log read endpoint — `audit.view` permission required. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listAuditLog } from "@/lib/features/audit/audit.service";

const Query = z.object({
  userEmail: z.string().email().optional(),
  action: z.string().max(120).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["audit.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const result = await listAuditLog({
    orgId: session.orgId,
    userEmail: params.userEmail,
    action: params.action,
    fromDate: params.fromDate ? new Date(`${params.fromDate}T00:00:00Z`) : undefined,
    toDate: params.toDate ? new Date(`${params.toDate}T23:59:59Z`) : undefined,
    cursor: params.cursor,
    limit: params.limit,
  });
  return ok(result);
}
