/**
 * POST /api/billing/claim-export — export reviewed claims as claim lines for
 * the billing software and mark them sent to billing (0118; Level-1 doc:72;
 * Mark Q1 default). Returns the CSV with the batch it was recorded as, and what
 * each claim lacks that the billing software will want.
 *
 * billing.superbills.export: it hands PHI out of Pallio, as the superbill PDF
 * does, and is logged as a PHI export.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { exportClaims } from "@/lib/features/billing/claim-export.service";

const Body = z
  .object({ superbillIds: z.array(z.string().uuid()).min(1, "Pick the claims to export").max(500) })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.export"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    return ok(await exportClaims({ orgId: session.orgId, userId: session.userId, superbillIds: body.superbillIds }), {
      status: 201,
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
