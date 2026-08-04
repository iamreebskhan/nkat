/**
 * Encounter transcription.
 *
 * Client walkthrough [00:19–00:30]: record the visit, and the transcript
 * appears on screen; the clinical note is then drafted from it.
 *
 * ── Why this is provider-pluggable rather than "just call Whisper" ──
 * An encounter recording is the most sensitive PHI this platform touches: a
 * verbatim palliative-care conversation naming the patient, their diagnosis,
 * prognosis and family. vision §15.4 and lib/ai/phi-guard.ts state the
 * platform's rule plainly — "no PHI to AI… we don't have a BAA". Posting the
 * audio to a third-party API would breach both that rule and, absent a signed
 * BAA, HIPAA itself (45 CFR §164.502(e)).
 *
 * So the engine is chosen by configuration, and the safe option is the default:
 *
 *   self_hosted  TRANSCRIPTION_URL points at a Whisper-compatible endpoint the
 *                org runs itself (whisper.cpp / faster-whisper on the VPS, or
 *                inside their own VPC). No PHI leaves the covered entity, so
 *                no BAA is needed. This is the recommended setup.
 *
 *   openai       Hosted Whisper. Refuses to run unless PHI_BAA_ACKNOWLEDGED is
 *                explicitly "true", so nobody enables PHI egress by accident —
 *                turning it on is a deliberate act by someone who has the BAA.
 *
 *   (unset)      Disabled. The UI says so rather than silently failing.
 *
 * Whichever engine runs is recorded on the visit for provenance.
 */
export type TranscriptionEngine = "self_hosted" | "openai";

export interface TranscriptionResult {
  text: string;
  /** Recorded on the visit — proves where the audio was processed. */
  engine: string;
}

export class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionUnavailableError";
  }
}

/** True when the deployment has a usable, compliant transcription engine. */
export function transcriptionStatus(): {
  available: boolean;
  engine: TranscriptionEngine | null;
  reason: string;
} {
  const url = process.env.TRANSCRIPTION_URL?.trim();
  if (url) {
    return {
      available: true,
      engine: "self_hosted",
      reason: "Self-hosted transcription — audio never leaves your infrastructure.",
    };
  }
  const provider = process.env.TRANSCRIPTION_PROVIDER?.trim();
  if (provider === "openai") {
    if (process.env.PHI_BAA_ACKNOWLEDGED !== "true") {
      return {
        available: false,
        engine: null,
        reason:
          "Hosted transcription is selected but PHI_BAA_ACKNOWLEDGED is not set to \"true\". " +
          "An encounter recording is PHI; enabling this without a signed BAA would breach HIPAA. " +
          "Prefer TRANSCRIPTION_URL (self-hosted).",
      };
    }
    if (!process.env.OPENAI_API_KEY) {
      return { available: false, engine: null, reason: "OPENAI_API_KEY is not set." };
    }
    return {
      available: true,
      engine: "openai",
      reason: "Hosted transcription with an acknowledged BAA.",
    };
  }
  return {
    available: false,
    engine: null,
    reason:
      "Transcription is not configured. Set TRANSCRIPTION_URL to a Whisper-compatible " +
      "endpoint you host (recommended — keeps PHI inside your infrastructure).",
  };
}

/**
 * Transcribe encounter audio. Throws TranscriptionUnavailableError when the
 * deployment isn't configured, so the route can answer 503 with the reason
 * rather than a generic failure.
 */
export async function transcribeAudio(args: {
  audio: Blob;
  filename: string;
}): Promise<TranscriptionResult> {
  const status = transcriptionStatus();
  if (!status.available || !status.engine) {
    throw new TranscriptionUnavailableError(status.reason);
  }

  const form = new FormData();
  form.set("file", args.audio, args.filename);
  form.set("model", "whisper-1");
  form.set("response_format", "json");

  if (status.engine === "self_hosted") {
    const url = process.env.TRANSCRIPTION_URL!.replace(/\/+$/, "");
    const r = await fetch(`${url}/v1/audio/transcriptions`, { method: "POST", body: form });
    if (!r.ok) {
      throw new Error(`Self-hosted transcription failed (${r.status}).`);
    }
    const j = (await r.json()) as { text?: string };
    return { text: (j.text ?? "").trim(), engine: "self_hosted:whisper" };
  }

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) {
    throw new Error(`Hosted transcription failed (${r.status}).`);
  }
  const j = (await r.json()) as { text?: string };
  return { text: (j.text ?? "").trim(), engine: "openai:whisper-1" };
}
