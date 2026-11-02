/**
 * One document (0112).
 *
 *   GET    — the file itself, opened in the browser (?download=1 saves it).
 *            Audited, and logged as a view of the chart when it is a patient's.
 *   DELETE — remove a document filed in error, with the reason: the content is
 *            emptied, the row and the reason stay.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { openDocument, removeDocument } from "@/lib/features/patient-documents/patient-document.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

/** The ASCII fallback and the UTF-8 name, for Content-Disposition. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const doc = await openDocument({ orgId: session.orgId, userId: session.userId, id });
    if (doc.patientId) {
      // So the chart's record-access timeline shows who opened it.
      await logPhiAccess({
        orgId: session.orgId,
        userId: session.userId,
        patientId: doc.patientId,
        accessType: "view",
        context: "patient_document",
        request: req,
      });
    }
    const download = new URL(req.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(doc.bytes), {
      status: 200,
      headers: {
        "Content-Type": doc.contentType,
        "Content-Length": String(doc.bytes.byteLength),
        "Content-Disposition": disposition(download ? "attachment" : "inline", doc.fileName),
        // The type is the one its bytes were checked to be at upload.
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}

const RemoveSchema = z.object({ reason: z.string().trim().min(1, "Say why it is being removed.").max(300) }).strict();

export async function DELETE(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, RemoveSchema);
  if (body instanceof Response) return body;
  try {
    await removeDocument({ orgId: session.orgId, userId: session.userId, id, reason: body.reason });
    return ok({ removed: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
