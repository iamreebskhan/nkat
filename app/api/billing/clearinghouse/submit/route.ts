/**
 * POST /api/billing/clearinghouse/submit — send reviewed claims to the
 * clearinghouse over the connection's SFTP channel, and record each one
 * submitted (0120).
 *
 * Takes billing.superbills.edit (it moves the claims to submitted) and
 * billing.superbills.export (it sends PHI out of Pallio). Every check a
 * person's "Record as submitted" runs runs first, for every claim; a claim
 * whose note misses what its payer requires asks for a reason, which the
 * screen sends back as documentationOverride.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { submitClaims, SubmissionDocumentationError } from "@/lib/features/clearinghouse/claim-file.service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z
  .object({
    connectionId: z.string().uuid("Pick the clearinghouse to send through."),
    superbillIds: z.array(z.string().uuid()).min(1, "Pick the claims to send").max(500),
    documentationOverride: z.object({ reason: z.string().trim().min(10).max(500) }).optional(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.edit", "billing.superbills.export"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    const r = await submitClaims({
      orgId: session.orgId,
      userId: session.userId,
      connectionId: body.connectionId,
      superbillIds: body.superbillIds,
      documentationOverride: body.documentationOverride,
    });
    return ok(r, { status: r.state === "sent" ? 201 : 200 });
  } catch (err) {
    // The refusal a screen can act on: it asks for the reason and sends again.
    if (err instanceof SubmissionDocumentationError) {
      return NextResponse.json(
        { success: false, data: { documentationIncomplete: err.gaps }, error: err.message },
        { status: 422 },
      );
    }
    return handleServiceError(err);
  }
}
