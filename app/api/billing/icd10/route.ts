/**
 * GET /api/billing/icd10?query=&limit= — ICD-10 autocomplete (Phase C.1).
 *
 * Clinical OR billing access. This used to be billing-only — and the people
 * who record what a visit addressed, the clinicians, hold no billing grant, so
 * the diagnosis could not be captured where it is actually known (audit R13).
 * ICD-10 is public reference data with no patient in it; gating it on billing
 * protected nothing and cost the claim its diagnosis.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseSearchParams, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { searchIcd10 } from "@/lib/features/billing/icd10.service";

const Schema = z.object({
  query: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const READ_ANY = [
  "billing.superbills.view",
  "visits.edit",
  "visits.view.own",
  "visits.view.all",
];

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }
  const params = parseSearchParams(new URL(req.url), Schema);
  if (params instanceof Response) return params;
  try {
    const rows = await searchIcd10({ query: params.query, limit: params.limit });
    return ok({ rows });
  } catch (err) {
    return handleServiceError(err);
  }
}
