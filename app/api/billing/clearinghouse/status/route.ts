/**
 * GET /api/billing/clearinghouse/status?ids=<uuid>,<uuid> — the
 * clearinghouse's latest word on each claim (0120), for the claims queue and
 * the bill page: sent, accepted by the clearinghouse, accepted or rejected by
 * the payer's front end, or a later status.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseSearchParamsAs } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { claimClearinghouseStatus } from "@/lib/features/clearinghouse/inbound.service";

const Query = z.object({
  ids: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().uuid()).max(500)),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParamsAs(new URL(req.url), Query);
  if (params instanceof Response) return params;
  try {
    return ok({ status: await claimClearinghouseStatus({ orgId: session.orgId, superbillIds: params.ids }) });
  } catch (err) {
    return handleServiceError(err);
  }
}
