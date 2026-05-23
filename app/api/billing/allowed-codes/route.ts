/**
 * GET /api/billing/allowed-codes
 *
 * Returns the list of CPT/HCPCS codes a payer covers in a given state
 * on a given date. Drives the super-bill payer-scoped picker (Phase A).
 *
 * Query params:
 *   payerId      UUID         required
 *   state        CHAR(2)      required
 *   dos          YYYY-MM-DD   optional, defaults to today
 *   productLine  string       optional, defaults to 'commercial'
 *   query        string       optional — filter by code prefix / descriptor
 *   limit        int          optional, 1..50
 *
 * Auth: `billing.lookup.view` (every clinician + billing role already has
 * it). The data is global reference, not org-scoped, so the role check
 * is just sanity, not isolation.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getAllowedCodesForPayer,
  searchAllowedCodes,
} from "@/lib/features/billing/payer-allowed-codes.service";

const Schema = z.object({
  payerId: z.string().uuid(),
  state: z.string().length(2),
  dos: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  productLine: z.string().min(1).max(40).optional(),
  query: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.lookup.view"]);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const params = parseSearchParams(url, Schema);
  if (params instanceof Response) return params;

  try {
    const rows = params.query
      ? await searchAllowedCodes({
          payerId: params.payerId,
          state: params.state.toUpperCase(),
          query: params.query,
          dos: params.dos,
          productLine: params.productLine,
          limit: params.limit,
        })
      : await getAllowedCodesForPayer({
          payerId: params.payerId,
          state: params.state.toUpperCase(),
          dos: params.dos,
          productLine: params.productLine,
        });
    return ok({ rows, total: rows.length });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Lookup failed", {
      status: 422,
    });
  }
}
