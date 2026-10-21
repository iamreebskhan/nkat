/**
 * The structured visit note.
 *
 * Replaces the single free-text box that was on this screen through the
 * 20 Aug 2026 walkthrough. Mark Hendrix, watching that box: [06:43] "I think
 * it'll make the box that you're typing in — it'll give you some structure to
 * understand how it needs to look on the finished product."
 *
 * Sections come from the org's template, so this component renders whatever the
 * org declares and never hard-codes a clinical section. Three kinds:
 *   prose  — rich text
 *   list   — one item per line (medications, allergies)
 *   vitals — numeric capture, saved to visit_vitals, not to a section
 *
 * Saves per section on blur, matching the editor's existing autosave contract.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";

import { TipTapEditor } from "@/components/editor/tiptap-editor";
import {
  VITALS_FIELDS,
  type VitalsFieldSpec,
} from "@/lib/features/visits/vitals-units";

type Kind = "prose" | "list" | "vitals";

interface Section {
  sectionKey: string;
  label: string;
  helpText: string | null;
  kind: Kind;
  isRequired: boolean;
  content: unknown;
  isEmpty: boolean;
  carriedFromVisitId: string | null;
  carriedUnchanged: boolean;
  updatedAt: string | null;
}

interface CarrySource {
  visitId: string;
  visitDate: string | null;
  visitTypeLabel: string | null;
  sections: { sectionKey: string; label: string }[];
}

interface Vitals {
  heightCm: number | null;
  weightKg: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  respRate: number | null;
  temperatureC: number | null;
  spo2Percent: number | null;
  ppsPercent: number | null;
  painScore: number | null;
  notes: string | null;
  recordedAt: string | null;
}

interface NoteView {
  templateName: string;
  templateVersion: number;
  sections: Section[];
  vitals: Vitals | null;
  missingRequired: { sectionKey: string; label: string }[];
}

/**
 * Entry is in US customary units; visit_vitals stores metric. VITALS_FIELDS
 * owns both the labels and the conversion, so the form has one code path and
 * the arithmetic is unit-tested away from React.
 */
const FIELDS = VITALS_FIELDS as (VitalsFieldSpec & { key: keyof Vitals })[];

export function SectionedNote({
  visitId,
  readOnly,
  onSaved,
  registerFlush,
}: {
  visitId: string;
  readOnly?: boolean;
  /** Fires after any successful write so the parent can refresh sign-readiness. */
  onSaved?: () => void;
  /**
   * Hands the parent a function that persists any section the clinician has
   * typed into but not yet blurred.
   *
   * Sections autosave on blur. Clicking "Sign + submit for billing" straight
   * after typing does not always blur the editor first, so without this the
   * last thing written before signing is lost — and the note locks on sign, so
   * it can never be added. Verified on localhost: a Goals-of-care paragraph
   * typed and then signed went to pending_billing with that section empty.
   */
  registerFlush?: (flush: () => Promise<boolean>) => void;
}) {
  const [note, setNote] = useState<NoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [carry, setCarry] = useState<CarrySource | null>(null);
  const [carrying, setCarrying] = useState(false);
  /** Sections typed into since their last successful save, keyed by section. */
  const pending = useRef(new Map<string, unknown>());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/visits/${visitId}/note`);
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not load the note.");
        return;
      }
      setNote(d.data as NoteView);
      setVitals((d.data as NoteView).vitals ?? blankVitals());
    } catch {
      setError("Network error loading the note.");
    }
  }, [visitId]);

  // Async IIFE with an abandon flag, matching the visit page's own load
  // effect — a bare `void load()` in the effect body is a synchronous setState
  // in React's eyes and trips react-hooks/set-state-in-effect.
  useEffect(() => {
    let abandoned = false;
    (async () => {
      const r = await fetch(`/api/visits/${visitId}/note`).catch(() => null);
      if (!r || abandoned) return;
      const d = await r.json().catch(() => null);
      if (!d || abandoned) return;
      if (!d.success) {
        setError(d.error ?? "Could not load the note.");
        return;
      }
      setNote(d.data as NoteView);
      setVitals((d.data as NoteView).vitals ?? blankVitals());

      const cr = await fetch(`/api/visits/${visitId}/carry-forward`).catch(() => null);
      if (!cr || abandoned) return;
      const cd = await cr.json().catch(() => null);
      if (cd?.success && !abandoned) setCarry(cd.data.source as CarrySource | null);
    })();
    return () => {
      abandoned = true;
    };
  }, [visitId]);

  /**
   * Bring forward every section this visit has not started. Never overwrites
   * anything already written here — the server enforces that too.
   */
  async function carryForward() {
    if (!carry || !note || readOnly) return;
    const emptyHere = new Set(note.sections.filter((s) => s.isEmpty).map((s) => s.sectionKey));
    const keys = carry.sections.map((s) => s.sectionKey).filter((k) => emptyHere.has(k));
    if (keys.length === 0) return;
    setCarrying(true);
    setError(null);
    try {
      const r = await fetch(`/api/visits/${visitId}/carry-forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromVisitId: carry.visitId, sectionKeys: keys }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not carry the note forward.");
        return;
      }
      await load();
      onSaved?.();
    } catch {
      setError("Network error carrying the note forward.");
    } finally {
      setCarrying(false);
    }
  }

  /** Returns whether the section is now persisted. */
  const saveSection = useCallback(async function saveSection(
    sectionKey: string,
    content: unknown,
    opts?: { silent?: boolean },
  ): Promise<boolean> {
    if (readOnly) return true;
    if (!opts?.silent) setSavingKey(sectionKey);
    setError(null);
    try {
      const r = await fetch(`/api/visits/${visitId}/note`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionKey, content }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not save this section.");
        return false;
      }
      pending.current.delete(sectionKey);
      // Re-read rather than patching local state: the server decides whether a
      // section counts as empty, and that drives the sign-off guard.
      await load();
      onSaved?.();
      return true;
    } catch {
      setError("Network error saving this section.");
      return false;
    } finally {
      setSavingKey(null);
    }
  }, [readOnly, visitId, load, onSaved]);

  /**
   * Persist everything typed but not yet blurred, and report whether it all
   * landed. The parent awaits this before signing.
   *
   * Returning the outcome is the point. saveSection reports a failure to the
   * clinician and keeps the section pending, but a caller that cannot see the
   * failure signs anyway — and signing locks the note, so the paragraph that
   * did not persist can never be added. That is the same data loss flush()
   * exists to prevent, just narrowed to the case where the network drops at
   * the moment of signing: a nurse in a patient's home, which is the setting
   * this product is for.
   */
  const flush = useCallback(async (): Promise<boolean> => {
    if (readOnly) return true;
    const entries = [...pending.current.entries()];
    let allSaved = true;
    for (const [key, content] of entries) {
      if (!(await saveSection(key, content, { silent: true }))) allSaved = false;
    }
    return allSaved;
  }, [readOnly, saveSection]);

  useEffect(() => {
    registerFlush?.(flush);
  }, [registerFlush, flush]);

  async function saveVitals(next: Vitals) {
    if (readOnly) return;
    setSavingKey("vitals");
    setError(null);
    try {
      // recordedAt is server-owned — the API stamps it — so it is not sent.
      const r = await fetch(`/api/visits/${visitId}/vitals`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          heightCm: next.heightCm, weightKg: next.weightKg,
          bpSystolic: next.bpSystolic, bpDiastolic: next.bpDiastolic,
          heartRate: next.heartRate, respRate: next.respRate,
          temperatureC: next.temperatureC, spo2Percent: next.spo2Percent,
          ppsPercent: next.ppsPercent, painScore: next.painScore,
          notes: next.notes,
        }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not save vitals.");
        return;
      }
      await load();
      onSaved?.();
    } catch {
      setError("Network error saving vitals.");
    } finally {
      setSavingKey(null);
    }
  }

  const missing = useMemo(
    () => new Set((note?.missingRequired ?? []).map((m) => m.sectionKey)),
    [note],
  );

  if (error && !note) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }
  if (!note) return <p className="text-sm text-slate-500">Loading the note…</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-slate-500">
          {note.templateName} · v{note.templateVersion}
        </p>
        {note.missingRequired.length > 0 && !readOnly && (
          <p className="text-xs text-amber-800">
            Still needed to sign:{" "}
            <strong>{note.missingRequired.map((m) => m.label).join(", ")}</strong>
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {carry && !readOnly && carry.sections.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 ring-1 ring-inset ring-slate-200">
          <p className="text-xs text-slate-700">
            Last signed visit{carry.visitTypeLabel ? ` · ${carry.visitTypeLabel}` : ""}
            {carry.visitDate ? ` · ${new Date(carry.visitDate).toLocaleDateString()}` : ""} has{" "}
            {carry.sections.length} completed section{carry.sections.length === 1 ? "" : "s"}.
          </p>
          <button
            type="button"
            onClick={() => void carryForward()}
            disabled={carrying || note.sections.every((s) => !s.isEmpty)}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-white ring-1 ring-inset ring-slate-300 hover:ring-slate-400 disabled:opacity-50"
          >
            {carrying ? "Bringing forward…" : "Carry forward into empty sections"}
          </button>
        </div>
      )}

      {note.sections.map((s) => (
        <section key={s.sectionKey} className="border-t border-slate-200 pt-4 first:border-t-0 first:pt-0">
          <div className="flex items-baseline gap-2 mb-1">
            <h3 className="text-sm font-semibold text-slate-800">{s.label}</h3>
            {s.isRequired && (
              <span
                className={`text-[10px] uppercase tracking-wide ${
                  missing.has(s.sectionKey) ? "text-amber-700" : "text-slate-400"
                }`}
              >
                required
              </span>
            )}
            {savingKey === s.sectionKey && (
              <span className="text-[10px] text-slate-400">saving…</span>
            )}
            {/*
              Visible on the note itself, not buried in an audit log. A
              clinician about to sign should see which paragraphs they have not
              actually written this visit — that is the whole point of making
              carry-forward explicit rather than silent.
            */}
            {s.carriedUnchanged && (
              <span className="text-[10px] uppercase tracking-wide text-amber-700">
                carried forward · unedited
              </span>
            )}
            {s.carriedFromVisitId && !s.carriedUnchanged && (
              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                carried forward · revised
              </span>
            )}
          </div>
          {s.helpText && <p className="text-xs text-slate-500 mb-2">{s.helpText}</p>}

          {s.kind === "prose" && (
            <TipTapEditor
              // TipTap builds its document once in useEditor and ignores later
              // `initial` changes. Without a key that moves when the server's
              // copy moves, a section filled after mount — carry-forward is the
              // case that bit — keeps showing an empty editor, and the next
              // blur saves that emptiness straight over the real text.
              key={`${s.sectionKey}:${s.updatedAt ?? "new"}`}
              initial={(s.content as JSONContent) ?? undefined}
              readOnly={readOnly}
              // Every keystroke registers the section as unsaved so flush()
              // can rescue it if the clinician signs without blurring.
              onChange={(doc) => pending.current.set(s.sectionKey, doc)}
              onBlurSave={(doc) => void saveSection(s.sectionKey, doc)}
              placeholder={s.label}
            />
          )}

          {s.kind === "list" && (
            <textarea
              defaultValue={listToText(s.content)}
              readOnly={readOnly}
              rows={4}
              aria-label={s.label}
              placeholder="One per line"
              onChange={(e) =>
                pending.current.set(s.sectionKey, { items: textToList(e.target.value) })
              }
              onBlur={(e) =>
                void saveSection(s.sectionKey, { items: textToList(e.target.value) })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm leading-6 read-only:bg-slate-50"
            />
          )}

          {s.kind === "vitals" && vitals && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {FIELDS.map((f) => {
                // The input holds the DISPLAYED unit; `vitals` holds metric.
                // Converting on the way in and out keeps the storage canonical
                // without ever showing a US clinician a number in kilograms.
                const shown = vitals[f.key] === null ? "" : String(f.fromStored(Number(vitals[f.key])));
                const toStored = (raw: string) =>
                  raw === "" ? null : f.toStored(Number(raw));
                return (
                  <label key={f.key} className="block">
                    <span className="block text-xs text-slate-600">
                      {f.label}
                      {f.unit && <span className="text-slate-400"> {f.unit}</span>}
                    </span>
                    <input
                      type="number"
                      step={f.step ?? "1"}
                      min={f.min}
                      max={f.max}
                      readOnly={readOnly}
                      value={shown}
                      onChange={(e) => setVitals({ ...vitals, [f.key]: toStored(e.target.value) })}
                      // Read the field's value off the event rather than off
                      // `vitals`. The closure captures the state as it was when
                      // this input rendered, so a change and a blur landing in
                      // the same tick would save the pre-change value — which is
                      // exactly what happens when the field is filled by anything
                      // faster than a human.
                      onBlur={(e) =>
                        void saveVitals({ ...vitals, [f.key]: toStored(e.target.value) })
                      }
                      className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm tabular read-only:bg-slate-50"
                    />
                  </label>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function blankVitals(): Vitals {
  return {
    heightCm: null, weightKg: null, bpSystolic: null, bpDiastolic: null,
    heartRate: null, respRate: null, temperatureC: null, spo2Percent: null,
    ppsPercent: null, painScore: null, notes: null, recordedAt: null,
  };
}

function listToText(content: unknown): string {
  const items = (content as { items?: unknown })?.items;
  return Array.isArray(items) ? items.filter((i) => typeof i === "string").join("\n") : "";
}

function textToList(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}
