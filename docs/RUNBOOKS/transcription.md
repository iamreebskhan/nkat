# Encounter transcription + note drafting

Recording a visit, turning it into a transcript, and drafting the clinical note
from that transcript. Requested by the client in the walkthrough at
[00:09–00:30]: *"is mein note nahi bante… transcript kaam kar lein — woh record
karne par karega."*

Both features ship **disabled**. This runbook is how you turn them on.

---

## Why they're off by default

A palliative-care encounter recording is the most sensitive PHI the platform
handles — a verbatim conversation naming the patient, their diagnosis, their
prognosis, and their family. The transcript is the same data in text form.

Under HIPAA, sending PHI to a third-party processor requires a signed **Business
Associate Agreement** with that processor (45 CFR §164.502(e)). Pallio's own
architecture says the same thing in stronger terms — `lib/ai/phi-guard.ts`:

> Source: pallio_complete_vision_v3 §15.4 ("no PHI to AI") … We don't have a
> BAA with Anthropic — every Claude call must be PHI-free.

So the code will not send a recording or a transcript anywhere unless someone
has deliberately configured where it goes. There is no default that quietly
leaks PHI.

---

## Option A — self-hosted (recommended)

Audio and transcript never leave your infrastructure, so **no BAA is needed**
and nothing has to be acknowledged.

Run a Whisper-compatible server on the app host (any OpenAI-shaped
`/v1/audio/transcriptions` endpoint works — `faster-whisper-server`,
`whisper.cpp`'s server, `speaches`):

```bash
docker run -d --restart unless-stopped -p 127.0.0.1:9000:8000 --name whisper fedirz/faster-whisper-server:latest-cpu
```

Then in `/opt/pallio/app/.env`:

```bash
TRANSCRIPTION_URL=http://127.0.0.1:9000
```

Bind it to `127.0.0.1`, not `0.0.0.0` — it must not be reachable from the
internet.

For note drafting, point `NOTE_DRAFT_URL` at any OpenAI-compatible chat
endpoint you host (llama.cpp server, vLLM, Ollama's `/v1`):

```bash
NOTE_DRAFT_URL=http://127.0.0.1:8080
NOTE_DRAFT_MODEL=llama-3.1-8b-instruct
```

Restart: `pm2 restart pallio`.

## Option B — hosted provider (requires a signed BAA)

Only if the organisation has executed a BAA with the provider.

```bash
TRANSCRIPTION_PROVIDER=openai
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
PHI_BAA_ACKNOWLEDGED=true
```

`PHI_BAA_ACKNOWLEDGED` must be the literal string `true`. Anything else — `1`,
`yes`, `TRUE` — leaves the features disabled. That is deliberate: enabling PHI
egress should be an explicit act, not a typo that happens to pass a truthiness
check.

## Option C — neither

Leave everything unset. The document screen shows why the recorder is
unavailable and offers "Paste a transcript instead", which stores a transcript
the clinician obtained elsewhere (engine recorded as `manual`). Note drafting
stays off.

---

## What gets stored where

| Data | Stored? | Where |
|---|---|---|
| Audio | **No.** Held in memory for one request, transcribed, released. | — |
| Transcript | Yes | `visit.transcript`, inside tenant RLS |
| Engine used | Yes | `visit.transcript_engine` — provenance for a PHI-disclosure review |
| Draft note | Only if the clinician saves it | `visit.document_text` |

Every transcript write and note draft is written to the PHI access log
(`visit_transcript` / `visit_note_draft` contexts).

## Guardrails worth knowing

- A drafted note is a **draft**. It loads into the editor; the clinician reads,
  corrects and signs it. Nothing is auto-signed and nothing is auto-billed.
- The drafting prompt forbids inventing findings, vitals, medications, or
  diagnoses, and instructs the model to write "Not documented in this
  encounter" instead of guessing.
- Uploads are capped at 25 MB.

## Verifying

```bash
curl -s -H "Cookie: $SESSION" https://app.pallio.io/api/visits/$VISIT_ID/transcribe | jq
```

`available: false` comes with a `reason` explaining exactly what's missing —
that same string is what the clinician sees on the document screen.

## Tests

`lib/features/visits/__tests__/transcription.spec.ts` covers the gate: off by
default, self-hosted needs no acknowledgement, hosted refuses without the
literal `true`. Treat those as compliance tests — if one starts failing, PHI
egress rules have changed and that needs a decision, not a fix.
