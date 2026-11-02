/**
 * POST /api/billing/clearinghouse/claim-file — build the 837P for reviewed
 * claims and hand it over, for the practice to upload to the clearinghouse
 * itself (0120). Claims do not move: the 999 and 277CA uploaded back confirm
 * them.
 *
 * billing.superbills.export: it hands PHI out of Pallio, as the CSV and the
 * superbill PDF do, and is logged as a PHI export.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { downloadClaimFile } from "@/lib/features/clearinghouse/claim-file.service";

const Body = z
  .object({
    connectionId: z.string().uuid("Pick the clearinghouse the file is for."),
    superbillIds: z.array(z.string().uuid()).min(1, "Pick the claims to put in the file").max(500),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.export"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    return ok(
      await downloadClaimFile({ orgId: session.orgId, userId: session.userId, connectionId: body.connectionId, superbillIds: body.superbillIds }),
      { status: 201 },
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
