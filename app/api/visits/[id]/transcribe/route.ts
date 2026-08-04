/**
 * Encounter recording → transcript.
 *
 *   GET  — is transcription configured? (drives the recorder UI's state)
 *   POST — multipart audio upload; transcribes and persists onto the visit.
 *
 * Client walkthrough [00:19–00:30]: the nurse records the visit and the
 * transcript appears on screen.
 *
 * The audio is never stored — it is transcribed in-request and dropped. The
 * transcript itself is PHI, so it goes onto the visit row (inside the tenant
 * RLS boundary) and the write is recorded in the PHI access log.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, handleServiceError, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVisit, saveTranscript } from "@/lib/features/visits/visit.service";
import {
  transcribeAudio,
  transcriptionStatus,
  TranscriptionUnavailableError,
} from "@/lib/features/visits/transcription.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

/** Guards against a runaway upload — ~25 MB is a long encounter at Opus/webm. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const ManualTranscriptSchema = z.object({
  transcript: z.string().trim().min(1, "The transcript is empty.").max(200_000),
});

export async function GET(): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;
  const s = transcriptionStatus();
  return ok({ available: s.available, engine: s.engine, reason: s.reason });
}

/**
 * PUT — attach a transcript the clinician already has (dictation app, an
 * outside transcription service, or typed by hand). Recorded as engine
 * "manual" so provenance stays honest, and usable on deployments that have
 * no transcription engine configured.
 */
export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  const body = await parseJson(req, ManualTranscriptSchema);
  if (body instanceof Response) return body;

  try {
    const visit = await getVisit({ orgId: session.orgId, id });
    if (!visit) return fail("Visit not found.", { status: 404 });

    await saveTranscript({
      orgId: session.orgId,
      id,
      transcript: body.transcript.trim(),
      engine: "manual",
    });

    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: visit.patientId,
      accessType: "edit",
      context: "visit_transcript",
      request: req,
    });

    return ok({ transcript: body.transcript.trim(), engine: "manual" });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // Fail fast when the deployment has no compliant engine, before we accept
  // a recording we can't process.
  const status = transcriptionStatus();
  if (!status.available) return fail(status.reason, { status: 503 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("Expected a multipart upload with an `audio` part.", { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) {
    return fail("Expected a multipart upload with an `audio` part.", { status: 400 });
  }
  if (audio.size === 0) return fail("The recording is empty.", { status: 422 });
  if (audio.size > MAX_AUDIO_BYTES) {
    return fail("Recording is too large. Split it into shorter segments.", { status: 413 });
  }

  try {
    const visit = await getVisit({ orgId: session.orgId, id });
    if (!visit) return fail("Visit not found.", { status: 404 });

    const filename = typeof form.get("filename") === "string"
      ? String(form.get("filename"))
      : "encounter.webm";
    const result = await transcribeAudio({ audio, filename });
    if (!result.text) {
      return fail("No speech was recognised in the recording.", { status: 422 });
    }

    await saveTranscript({
      orgId: session.orgId,
      id,
      transcript: result.text,
      engine: result.engine,
    });

    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: visit.patientId,
      accessType: "edit",
      context: "visit_transcript",
      request: req,
    });

    return ok({ transcript: result.text, engine: result.engine });
  } catch (err) {
    if (err instanceof TranscriptionUnavailableError) {
      return fail(err.message, { status: 503 });
    }
    return handleServiceError(err);
  }
}
