/**
 * The multipart upload both document routes take (0112): a `file` and its
 * `kind`. What the bytes are is the service's to decide (sniffDocumentType);
 * here only the shape and the size, before the body is read into memory twice.
 */
import { fail } from "@/lib/api";

import { DOCUMENT_KINDS, DOCUMENT_MAX_BYTES, type DocumentKind } from "./patient-document.types";

export async function readDocumentUpload(
  req: Request,
): Promise<{ kind: DocumentKind; fileName: string; bytes: Uint8Array } | Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("Expected multipart/form-data with a 'file' field.", { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail("No file provided.", { status: 400 });
  if (file.size === 0) return fail("The file is empty.", { status: 422 });
  if (file.size > DOCUMENT_MAX_BYTES) {
    return fail(`File too large (max ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB).`, { status: 413 });
  }
  const kind = form.get("kind");
  if (typeof kind !== "string" || !(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    return fail("Say what the document is.", { status: 422 });
  }
  return { kind: kind as DocumentKind, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
