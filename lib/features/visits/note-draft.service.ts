/**
 * Draft a clinical note from an encounter transcript.
 *
 * Client walkthrough [00:09]: "is mein note nahi bante" — the transcript
 * arrives but no note is produced. This closes that loop.
 *
 * ── PHI boundary ──
 * A transcript is PHI, and lib/ai/phi-guard.ts records the platform's rule:
 * no PHI to Anthropic, because there is no BAA. Note drafting therefore runs
 * only when the operator has explicitly acknowledged a BAA
 * (PHI_BAA_ACKNOWLEDGED=true) or pointed NOTE_DRAFT_URL at a model they host
 * themselves. Default: disabled, with the reason surfaced to the user.
 *
 * The output is a DRAFT. It lands in the editor for the clinician to read,
 * correct and sign — it is never auto-signed, and never auto-submitted for
 * billing. The signature stays a human act.
 */
export class NoteDraftUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteDraftUnavailableError";
  }
}

export function noteDraftStatus(): { available: boolean; reason: string } {
  if (process.env.NOTE_DRAFT_URL?.trim()) {
    return {
      available: true,
      reason: "Self-hosted note drafting — the transcript never leaves your infrastructure.",
    };
  }
  if (process.env.PHI_BAA_ACKNOWLEDGED === "true" && process.env.ANTHROPIC_API_KEY) {
    return { available: true, reason: "Hosted note drafting with an acknowledged BAA." };
  }
  return {
    available: false,
    reason:
      "Note drafting is off. A transcript is PHI, so this needs either NOTE_DRAFT_URL " +
      "(a model you host) or PHI_BAA_ACKNOWLEDGED=true with a signed BAA in place.",
  };
}

const SYSTEM = `You are helping a palliative-care nurse practitioner turn a recorded home-visit into a clinical note.

Write the note in this structure, using only what the transcript supports:

SUBJECTIVE — what the patient and family reported, in their words where useful.
OBJECTIVE — observed findings, vitals and exam only if stated.
ASSESSMENT — the clinician's impression.
PLAN — next steps, medication changes, follow-up, goals-of-care decisions.

Rules:
- Never invent a finding, vital sign, medication or diagnosis that is not in the transcript.
- If something important is missing (e.g. no vitals discussed), write "Not documented in this encounter" under that heading rather than guessing.
- Keep the clinician's clinical voice; do not add reassurance or advice of your own.
- This is a DRAFT for a clinician to review, correct and sign.`;

/**
 * Returns note text for the editor. Best-effort: the caller shows the reason
 * when unavailable rather than blocking documentation.
 */
export async function draftNoteFromTranscript(args: {
  transcript: string;
  visitType: string;
}): Promise<{ note: string; engine: string }> {
  const status = noteDraftStatus();
  if (!status.available) throw new NoteDraftUnavailableError(status.reason);

  const userPrompt = `Visit type: ${args.visitType.replace(/_/g, " ")}\n\nTranscript:\n"""\n${args.transcript}\n"""`;

  const selfHosted = process.env.NOTE_DRAFT_URL?.trim();
  if (selfHosted) {
    const r = await fetch(`${selfHosted.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.NOTE_DRAFT_MODEL ?? "local",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1500,
      }),
    });
    if (!r.ok) throw new Error(`Self-hosted note drafting failed (${r.status}).`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return {
      note: (j.choices?.[0]?.message?.content ?? "").trim(),
      engine: "self_hosted",
    };
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!r.ok) throw new Error(`Note drafting failed (${r.status}).`);
  const j = (await r.json()) as { content?: { text?: string }[] };
  return {
    note: (j.content ?? []).map((c) => c.text ?? "").join("").trim(),
    engine: "anthropic:claude-opus-4-8",
  };
}
