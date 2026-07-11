/**
 * GET /api/billing/icd10?query=&limit= — ICD-10 autocomplete (Phase C.1).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { searchIcd10 } from "@/lib/features/billing/icd10.service";

const Schema = z.object({
  query: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Schema);
  if (params instanceof Response) return params;
  try {
    const rows = await searchIcd10({ query: params.query, limit: params.limit });
    return ok({ rows });
  } catch (err) {
    return handleServiceError(err);
  }
}
