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
 *   productLine  string       optional; defaults to the line implied by
 *                             the payer's payer_type (see below)
 *   query        string       optional — filter by code prefix / descriptor
 *   limit        int          optional, 1..50
 *
 * Auth: `billing.lookup.view` (every clinician + billing role already has
 * it). The data is global reference, not org-scoped, so the role check
 * is just sanity, not isolation.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getAllowedCodesForPayer,
  searchAllowedCodes,
} from "@/lib/features/billing/payer-allowed-codes.service";
import {
  defaultProductLineForPayerType,
  getPayerType,
} from "@/lib/features/billing/payer-rule.repository";

const Schema = z.object({
  payerId: z.string().uuid(),
  state: z.string().length(2),
  dos: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  productLine: z.string().min(1).max(40).optional(),
  query: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  /** Phase A "show all" — also include not_covered / unknown codes. */
  includeDenied: z.coerce.boolean().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.lookup.view"]);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const params = parseSearchParams(url, Schema);
  if (params instanceof Response) return params;

  try {
    // getAllowedCodesForPayer filters product_line EXACTLY, and its own
    // default is 'commercial'. That made the picker return nothing for
    // every Medicaid MCO on the platform: measured on the reference
    // library, the 13 medicaid_mco payers have 152 rows in
    // payer_allowed_codes_v, all under product_line='medicaid_mco' and
    // none under 'commercial'. Derive the default from the payer instead.
    // An explicit caller value still wins — this only fills the blank.
    const productLine =
      params.productLine ??
      defaultProductLineForPayerType(await getPayerType(params.payerId));

    const rows = params.query
      ? await searchAllowedCodes({
          payerId: params.payerId,
          state: params.state.toUpperCase(),
          query: params.query,
          dos: params.dos,
          productLine,
          limit: params.limit,
          includeDenied: params.includeDenied,
        })
      : await getAllowedCodesForPayer({
          payerId: params.payerId,
          state: params.state.toUpperCase(),
          dos: params.dos,
          productLine,
          includeDenied: params.includeDenied,
        });
    return ok({ rows, total: rows.length });
  } catch (err) {
    return handleServiceError(err);
  }
}
