/**
 * POST /api/billing/clearinghouse/preview — what would stop each claim from
 * going in a file for this connection, and what it would go with (0120). A
 * read: nothing is built or recorded.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { previewClaims } from "@/lib/features/clearinghouse/claim-file.service";

const Body = z
  .object({
    connectionId: z.string().uuid(),
    superbillIds: z.array(z.string().uuid()).min(1).max(500),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    return ok({ claims: await previewClaims({ orgId: session.orgId, connectionId: body.connectionId, superbillIds: body.superbillIds }) });
  } catch (err) {
    return handleServiceError(err);
  }
}
