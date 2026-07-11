/**
 * POST /api/rulebook/upload — Path B ingestion (gap A).
 *
 * multipart/form-data:
 *   file  : the upload (CSV rulebook, or .txt/.md policy doc)
 *   kind  : "rulebook" (default) | "document"
 *   payerId, state, title : optional metadata for "document" kind
 *
 * rulebook → rulebook_upload row + parsed_rows (feeds comparison)
 * document → source_document + embedded document_chunk (feeds RAG)
 */
import { type NextRequest } from "next/server";

import { ok, fail, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  ingestPolicyDocument,
  ingestRulebookCsv,
} from "@/lib/features/documents/ingestion.service";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.upload"]);
  if (session instanceof Response) return session;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("Expected multipart/form-data with a 'file' field.", { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail("No file provided.", { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return fail(`File too large (max ${MAX_BYTES / 1024 / 1024} MB).`, { status: 413 });
  }
  const kind = (form.get("kind")?.toString() ?? "rulebook").toLowerCase();
  const text = await file.text();

  try {
    if (kind === "document") {
      const r = await ingestPolicyDocument({
        payerId: (form.get("payerId")?.toString() || null) as string | null,
        state: (form.get("state")?.toString() || null) as string | null,
        url: `upload://${file.name}`,
        title: form.get("title")?.toString() || file.name,
        text,
      });
      return ok(r, { status: 201 });
    }

    const r = await ingestRulebookCsv({
      orgId: session.orgId,
      userId: session.userId,
      filename: file.name,
      mimeType: file.type || "text/csv",
      csvText: text,
    });
    if (r.parsedRowCount === 0) {
      return fail(
        `No valid rows parsed. ${r.errors.slice(0, 3).join(" | ")}`,
        { status: 422 },
      );
    }
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
