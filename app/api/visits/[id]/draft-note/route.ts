/**
 * POST /api/visits/[id]/draft-note
 *
 * Turn the visit's transcript into a draft clinical note.
 *
 * Client walkthrough [00:09]: "is mein note nahi bante" — the transcript
 * arrived but nothing wrote the note.
 *
 * The draft is RETURNED, not saved. It lands in the editor for the clinician
 * to read, correct and sign; nothing is auto-signed and nothing is auto-billed.
 */
import { type NextRequest } from "next/server";

import { ok, fail, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVisit } from "@/lib/features/visits/visit.service";
import {
  draftNoteFromTranscript,
  noteDraftStatus,
  NoteDraftUnavailableError,
} from "@/lib/features/visits/note-draft.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;
  return ok(noteDraftStatus());
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  const status = noteDraftStatus();
  if (!status.available) return fail(status.reason, { status: 503 });

  try {
    const visit = await getVisit({ orgId: session.orgId, id });
    if (!visit) return fail("Visit not found.", { status: 404 });
    if (!visit.transcript) {
      return fail("Record the encounter first — there's no transcript to work from.", {
        status: 422,
      });
    }

    const { note, engine } = await draftNoteFromTranscript({
      transcript: visit.transcript,
      visitType: visit.visitType,
    });
    if (!note) return fail("The draft came back empty. Write the note manually.", { status: 422 });

    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: visit.patientId,
      accessType: "view",
      context: "visit_note_draft",
      request: req,
    });

    return ok({ note, engine });
  } catch (err) {
    if (err instanceof NoteDraftUnavailableError) {
      return fail(err.message, { status: 503 });
    }
    return handleServiceError(err);
  }
}
