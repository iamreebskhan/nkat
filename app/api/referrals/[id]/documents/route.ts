/**
 * A referral's paperwork (0112; Mark Q11j default: kept on the patient as
 * attachments, which admission does).
 *
 *   GET  — the documents, without their files
 *   POST — multipart: `file` (PDF, JPEG or PNG, up to 10 MB) and `kind`
 *
 * Attaching takes patients.edit, as recording a coverage check does: intake
 * and the triaging nurse both hold it.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { readDocumentUpload } from "@/lib/features/patient-documents/document-upload";
import { addDocument, listDocuments } from "@/lib/features/patient-documents/patient-document.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok({ documents: await listDocuments({ orgId: session.orgId, subject: { referralId: id } }) });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const upload = await readDocumentUpload(req);
  if (upload instanceof Response) return upload;
  try {
    const r = await addDocument({
      orgId: session.orgId,
      userId: session.userId,
      subject: { referralId: id },
      ...upload,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
