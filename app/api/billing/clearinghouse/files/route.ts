/**
 * /api/billing/clearinghouse/files — the response files read, and uploading
 * one by hand (0120): a 999, TA1, 277CA, 277 or 835 downloaded from the
 * clearinghouse's portal. Reading the same file again applies nothing twice.
 *
 * POST multipart/form-data with a `file` field (and `connectionId` when the
 * file came from a known connection). It moves claim statuses and can post
 * an 835's denials, so it takes what uploading an 835 takes:
 * billing.superbills.edit and billing.denials.log.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, handleServiceError, isUuid, ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { ingestClearinghouseFile, listClearinghouseFiles } from "@/lib/features/clearinghouse/inbound.service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_BYTES = 5 * 1024 * 1024;

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
  if (file.size > MAX_BYTES) return fail(`File too large (max ${MAX_BYTES / 1024 / 1024} MB).`, { status: 413 });
  const connectionId = form.get("connectionId");
  if (connectionId !== null && (typeof connectionId !== "string" || (connectionId !== "" && !isUuid(connectionId)))) {
    return fail("Unknown connection.", { status: 422 });
  }
  try {
    const report = await ingestClearinghouseFile({
      orgId: session.orgId,
      userId: session.userId,
      connectionId: typeof connectionId === "string" && connectionId !== "" ? connectionId : null,
      source: "upload",
      name: file.name,
      text: await file.text(),
    });
    return ok(report, { status: report.alreadyRead ? 200 : 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}

const Query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  try {
    return ok({ files: await listClearinghouseFiles({ orgId: session.orgId, limit: params.limit }) });
  } catch (err) {
    return handleServiceError(err);
  }
}
