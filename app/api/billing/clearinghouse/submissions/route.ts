/**
 * GET /api/billing/clearinghouse/submissions — the 837P files Pallio built,
 * newest first, each with its claims and what came back for them (0120).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listSubmissions } from "@/lib/features/clearinghouse/inbound.service";

const Query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  try {
    return ok({ submissions: await listSubmissions({ orgId: session.orgId, limit: params.limit }) });
  } catch (err) {
    return handleServiceError(err);
  }
}
