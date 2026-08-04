/**
 * Encounter recorder → transcript → draft note.
 *
 * Client walkthrough [00:09–00:30]:
 *   "is mein note nahi bante… transcript kaam kar lein — woh record karne par
 *    karega; recording ho rahi hai, is ke baad screen par aayega."
 *
 * Record the visit → the transcript appears on screen → one click drafts the
 * clinical note into the editor for the clinician to correct and sign.
 *
 * The audio never touches disk: it is held in memory, POSTed once, and
 * released. Only the transcript is persisted (on the visit, inside the tenant
 * boundary). If the deployment has no transcription engine configured, the
 * panel says so plainly and offers the paste-a-transcript path instead of
 * failing silently.
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type EngineStatus = { available: boolean; reason: string };

export function EncounterRecorder({
  visitId,
  initialTranscript,
  initialEngine,
  onNoteDrafted,
}: {
  visitId: string;
  initialTranscript: string | null;
  initialEngine: string | null;
  /** Hands the drafted note back to the page, which loads it into the editor. */
  onNoteDrafted: (note: string) => void;
}) {
  const [transcript, setTranscript] = useState(initialTranscript ?? "");
  const [engine, setEngine] = useState(initialEngine);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState<null | "transcribing" | "drafting" | "saving">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transcribeStatus, setTranscribeStatus] = useState<EngineStatus | null>(null);
  const [draftStatus, setDraftStatus] = useState<EngineStatus | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Ask the server what's configured, so the buttons tell the truth before
  // the clinician has recorded anything.
  useEffect(() => {
    let abandoned = false;
    (async () => {
      const [t, d] = await Promise.all([
        fetch(`/api/visits/${visitId}/transcribe`).then((r) => r.json()).catch(() => null),
        fetch(`/api/visits/${visitId}/draft-note`).then((r) => r.json()).catch(() => null),
      ]);
      if (abandoned) return;
      if (t?.success) setTranscribeStatus(t.data);
      if (d?.success) setDraftStatus(d.data);
    })();
    return () => {
      abandoned = true;
    };
  }, [visitId]);

  // Live timer while recording.
  useEffect(() => {
    if (!recording) return;
    const h = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(h);
  }, [recording]);

  // Release the microphone if the clinician navigates away mid-recording —
  // otherwise the browser keeps the "recording" indicator lit.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function startRecording() {
    setError(null);
    setNotice(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't record audio. Use the paste-transcript option below.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        chunksRef.current = [];
        void upload(blob);
      };
      recorderRef.current = rec;
      rec.start();
      setElapsed(0);
      setRecording(true);
    } catch {
      setError(
        "Microphone access was denied. Allow it in your browser, or paste a transcript below.",
      );
    }
  }

  function stopRecording() {
    setRecording(false);
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  async function upload(blob: Blob) {
    if (blob.size === 0) {
      setError("Nothing was recorded.");
      return;
    }
    setBusy("transcribing");
    setError(null);
    try {
      const form = new FormData();
      form.set("audio", blob, "encounter.webm");
      form.set("filename", "encounter.webm");
      const r = await fetch(`/api/visits/${visitId}/transcribe`, {
        method: "POST",
        body: form,
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Transcription failed.");
        return;
      }
      setTranscript(data.data.transcript);
      setEngine(data.data.engine);
      setNotice("Transcript saved.");
    } catch {
      setError("Network error while uploading the recording.");
    } finally {
      setBusy(null);
    }
  }

  async function saveManual() {
    if (!pasted.trim()) return;
    setBusy("saving");
    setError(null);
    try {
      const r = await fetch(`/api/visits/${visitId}/transcribe`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: pasted }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not save the transcript.");
        return;
      }
      setTranscript(data.data.transcript);
      setEngine("manual");
      setPasting(false);
      setPasted("");
      setNotice("Transcript saved.");
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  async function draftNote() {
    setBusy("drafting");
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/visits/${visitId}/draft-note`, { method: "POST" });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not draft the note.");
        return;
      }
      onNoteDrafted(data.data.note);
      setNotice("Draft loaded into the editor — review and correct it before signing.");
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  const canRecord = transcribeStatus?.available ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recording</CardTitle>
        <CardDescription>
          Record the encounter to produce a transcript, then draft the note from it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          {recording ? (
            <Button variant="secondary" onClick={stopRecording}>
              ■ Stop
            </Button>
          ) : (
            <Button
              onClick={startRecording}
              disabled={!canRecord || busy !== null}
              loading={busy === "transcribing"}
            >
              ● Record
            </Button>
          )}
          {recording && (
            <span className="flex items-center gap-2 text-red-700" aria-live="polite">
              <span className="h-2 w-2 rounded-full bg-red-600 animate-pulse" aria-hidden />
              <span className="tabular">{formatElapsed(elapsed)}</span>
              <span className="text-xs text-slate-600">Recording…</span>
            </span>
          )}
          {busy === "transcribing" && (
            <span className="text-xs text-slate-600" aria-live="polite">
              Transcribing…
            </span>
          )}
        </div>

        {/* Say why the button is off rather than leaving a dead control. */}
        {transcribeStatus && !transcribeStatus.available && (
          <p className="text-xs text-amber-900 bg-amber-50 px-2 py-2 rounded ring-1 ring-inset ring-amber-600/30">
            {transcribeStatus.reason}
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-700 bg-red-50 px-2 py-2 rounded">
            {error}
          </p>
        )}
        {notice && (
          <p className="text-xs text-emerald-800 bg-emerald-50 px-2 py-2 rounded" aria-live="polite">
            {notice}
          </p>
        )}

        {transcript ? (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="font-medium text-slate-700">Transcript</span>
              {engine && (
                <span className="text-[11px] text-slate-500" title="Where the audio was processed">
                  {engine}
                </span>
              )}
            </div>
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {transcript}
            </div>
            <Button
              variant="secondary"
              onClick={draftNote}
              loading={busy === "drafting"}
              disabled={busy !== null || !(draftStatus?.available ?? false)}
            >
              Draft note from transcript
            </Button>
            {draftStatus && !draftStatus.available && (
              <p className="text-xs text-amber-900 bg-amber-50 px-2 py-2 rounded ring-1 ring-inset ring-amber-600/30">
                {draftStatus.reason}
              </p>
            )}
            <p className="text-[11px] text-slate-500">
              Any draft is a starting point — read it against the encounter and correct it.
              Nothing is signed or billed without you.
            </p>
          </div>
        ) : pasting ? (
          <div className="space-y-2">
            <label className="block">
              <span className="text-slate-700 font-medium">Paste a transcript</span>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={6}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                placeholder="Paste the transcript from your dictation app…"
              />
            </label>
            <div className="flex gap-2">
              <Button onClick={saveManual} loading={busy === "saving"} disabled={!pasted.trim()}>
                Save transcript
              </Button>
              <Button variant="ghost" onClick={() => setPasting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPasting(true)}
            className="text-xs text-[var(--color-brand-700)] underline"
          >
            Paste a transcript instead
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
