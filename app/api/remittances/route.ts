/**
 * /api/remittances — upload a payer's ERA/835, and list what has been
 * uploaded (audit R10).
 *
 * POST multipart/form-data with a `file` field: the 835 the org downloaded
 * from its clearinghouse or the payer's portal. Its claims post to the bills
 * they match and the response is the posting report. Uploading the same file
 * again is safe: only what did not post is retried.
 *
 * Posting moves claim statuses and records denials, so it takes both
 * billing.superbills.edit and billing.denials.log — requireAuth wants every
 * permission listed — the same two a person needs to do it by hand.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, handleServiceError, ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  ingestRemittance,
  listRemittanceFiles,
} from "@/lib/features/remittances/remittance.service";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.edit", "billing.denials.log"]);
  if (session instanceof Response) return session;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("Expected multipart/form-data with a 'file' field.", { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail("No file provided.", { status: 400 });
  if (file.size === 0) return fail("The file is empty.", { status: 422 });
  if (file.size > MAX_BYTES) {
    return fail(`File too large (max ${MAX_BYTES / 1024 / 1024} MB).`, { status: 413 });
  }
  const text = await file.text();

  try {
    const report = await ingestRemittance({
      orgId: session.orgId,
      userId: session.userId,
      filename: file.name,
      text,
    });
    return ok(report, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  try {
    const files = await listRemittanceFiles({ orgId: session.orgId, limit: params.limit });
    return ok({ files });
  } catch (err) {
    return handleServiceError(err);
  }
}
