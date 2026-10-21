/**
 * /schedule — upcoming + recently-scheduled visits.
 *
 * Source: pallio_complete_vision_v3 §6.3.
 *
 * MVP: grouped-by-day list + inline new-visit composer that posts to
 * /api/visits. A real week-grid + drag-to-reschedule lands in a
 * follow-on phase.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { FieldMarker } from "@/components/forms/field-marker";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { loadClinicianOptions } from "@/lib/features/schedule/clinician-options";
import { visitTypeHistoryWarning } from "@/lib/features/visits/visit-pure";
import {
  NEW_PATIENT_LOOKBACK_YEARS,
  TELEHEALTH_MODALITIES,
  type VisitType,
  type VisitTypeHint,
  type VisitView,
} from "@/lib/features/visits/visit.types";

interface PatientOption { id: string; firstName: string; lastName: string }
interface MemberOption  { userId: string; email: string; fullName: string | null }

interface ExternalBusy { summary: string; start: string; end: string; userId: string | null }
interface TimeOffEntry { id: string; clinicianUserId: string; clinicianName: string | null; startDate: string; endDate: string; reason: string | null }

// NB: this page deliberately does NOT use next/navigation's useSearchParams.
// That hook forces the component under a Suspense boundary and defers it to
// the client; on a cold load the boundary could stall on its fallback, leaving
// the page blank. The only query param we need (?patientId=) is read from
// window.location in a mount effect below — purely to pre-open the composer —
// so the page renders its full chrome server-side/immediately, every time.
export default function SchedulePage() {
  const [visits, setVisits] = useState<VisitView[]>([]);
  const [externalBusy, setExternalBusy] = useState<ExternalBusy[]>([]);
  const [timeOff, setTimeOff] = useState<TimeOffEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [addingPto, setAddingPto] = useState(false);
  // Monday of the displayed week (local).
  const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(new Date()));

  const router = useRouter();
  const [preselectPatientId, setPreselectPatientId] = useState("");
  /**
   * The visit picked up for a tap-to-move.
   *
   * Rescheduling used to be HTML5 drag-and-drop only. HTML5 DnD does not fire
   * on touch at all, so on the device this product is actually used on — the
   * client, 20 Aug 2026 [12:30]: "most nurse practitioners actually see the
   * patients with an iPad and touchscreen, so they just click through it" —
   * the schedule board was read-only. Drag still works for a mouse; this is
   * the path that works for a finger.
   */
  const [moving, setMoving] = useState<{ id: string; label: string; start: string | null } | null>(
    null,
  );

  // Read ?patientId= client-side (see note on the component above). Runs once
  // on mount; opens the composer pre-filled when arriving from a patient's
  // "Schedule visit" link.
  // Deferred to a microtask so the setState lands after the effect body
  // rather than synchronously inside it, which React flags as a cascading
  // render (react-hooks/set-state-in-effect).
  useEffect(() => {
    let abandoned = false;
    void Promise.resolve().then(() => {
      if (abandoned) return;
      const pid = new URLSearchParams(window.location.search).get("patientId");
      if (pid) {
        setPreselectPatientId(pid);
        setComposing(true);
      }
    });
    return () => {
      abandoned = true;
    };
  }, []);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

  async function reload() {
    setLoading(true);
    try {
      const [vr, cr] = await Promise.all([
        fetch("/api/visits?status=scheduled&limit=200").then((r) => r.json()),
        fetch(
          `/api/schedule/context?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`,
        ).then((r) => r.json()),
      ]);
      if (!vr.success) {
        setError(vr.error ?? "Failed to load.");
        return;
      }
      setVisits(vr.data.rows ?? []);
      if (cr.success) {
        setExternalBusy(cr.data.externalBusy ?? []);
        setTimeOff(cr.data.timeOff ?? []);
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let abandoned = false;
    // Deferred for the same reason as the mount effect above: reload() sets
    // state, and calling it straight from the effect body is a synchronous
    // setState in React's eyes.
    void Promise.resolve().then(() => {
      if (!abandoned) void reload();
    });
    return () => {
      abandoned = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  async function reschedule(visitId: string, dayIso: string, originalIso: string | null) {
    // Keep the original time-of-day, move to the dropped day.
    const orig = originalIso ? new Date(originalIso) : new Date();
    const target = new Date(`${dayIso}T00:00:00`);
    target.setHours(orig.getHours(), orig.getMinutes(), 0, 0);
    const send = (confirmDoubleBook: boolean) =>
      fetch(`/api/visits/${visitId}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scheduledStart: target.toISOString(),
          ...(confirmDoubleBook ? { confirmDoubleBook: true } : {}),
        }),
      });
    let r = await send(false);
    let d = await r.json();
    // 409: the clinician's day is at capacity, or Google Calendar has
    // something there — the checks booking makes. Offer to move it anyway,
    // as the booking form offers to schedule anyway.
    if (r.status === 409) {
      if (!window.confirm(`${d.error ?? "That slot is taken."}\n\nMove it anyway?`)) return;
      r = await send(true);
      d = await r.json();
    }
    if (!d.success) {
      alert(d.error ?? "Reschedule failed.");
      return;
    }
    void reload();
  }

  const byDay = useMemo(() => {
    const map = new Map<string, VisitView[]>();
    for (const v of visits) {
      const ts = v.scheduledStart ?? v.startTime;
      if (!ts) continue;
      // The day in the viewer's own zone, which is what the columns and the
      // times on the chips are in, and what the printed route sheet files it
      // under. ts.slice(0, 10) was the UTC day: a 3 pm Ohio visit seen from
      // Karachi sat under Wednesday showing "0:00", which is Thursday there.
      const day = isoDay(new Date(ts));
      const arr = map.get(day) ?? [];
      arr.push(v);
      map.set(day, arr);
    }
    return map;
  }, [visits]);

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Schedule</h1>
          <p className="text-slate-600 mt-1">
            {/* Fixed locale on purpose. `undefined` uses the runtime's locale,
                which differs between the Node server and the browser — the
                server rendered "August 3" and the client "3 August", throwing
                a hydration mismatch and forcing React to regenerate the tree
                on every load of this page. */}
            Week of {weekStart.toLocaleDateString("en-US", { month: "long", day: "numeric" })}.
            {moving
              ? " Now tap the day to move it to."
              : " Tap a visit to move it, or drag it to another day."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Prev</Button>
          <Button variant="secondary" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</Button>
          <Button variant="secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</Button>
          <Link
            href={`/schedule/print?date=${isoDay(days[0]!)}`}
            target="_blank"
            className="inline-flex"
          >
            <Button variant="secondary">Print route</Button>
          </Link>
          <Button variant="secondary" onClick={() => setAddingPto((v) => !v)}>
            {addingPto ? "Close PTO" : "Add PTO"}
          </Button>
          <Button onClick={() => setComposing((v) => !v)}>
            {composing ? "Close" : "New visit"}
          </Button>
        </div>
      </header>

      {composing && (
        <NewVisitComposer
          defaultPatientId={preselectPatientId}
          onCreated={(visitId) => {
            setComposing(false);
            void reload();
            if (confirm("Visit scheduled. Open documentation now?")) {
              router.push(`/visits/${visitId}/document`);
            }
          }}
          onCancel={() => setComposing(false)}
        />
      )}

      {addingPto && (
        <PtoComposer
          onCreated={() => {
            setAddingPto(false);
            void reload();
          }}
          onCancel={() => setAddingPto(false)}
        />
      )}

      {loading && <p className="text-slate-500">Loading…</p>}
      {error && <p role="alert" className="text-red-700">{error}</p>}

      {moving && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/30"
        >
          <span>
            Moving <strong>{moving.label}</strong> — tap the day to move it to.
          </span>
          <button
            type="button"
            onClick={() => setMoving(null)}
            className="rounded-md bg-white px-3 py-1.5 text-xs font-medium ring-1 ring-inset ring-amber-600/40"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
        {days.map((day) => {
          const dayIso = isoDay(day);
          const dayVisits = (byDay.get(dayIso) ?? []).sort((a, b) =>
            (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""),
          );
          const dayPto = timeOff.filter((t) => dayIso >= t.startDate && dayIso <= t.endDate);
          // As the visits: the viewer's day, not the UTC one. An all-day event
          // can arrive as a bare date, which is already the day.
          const dayBusy = externalBusy.filter(
            (b) => (/^\d{4}-\d{2}-\d{2}$/.test(b.start) ? b.start : isoDay(new Date(b.start))) === dayIso,
          );
          const isToday = dayIso === isoDay(new Date());
          return (
            <div
              key={dayIso}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const id = e.dataTransfer.getData("text/visit-id");
                const orig = e.dataTransfer.getData("text/visit-start");
                if (id) void reschedule(id, dayIso, orig || null);
              }}
              // While a visit is picked up, the whole column is the drop
              // target — a finger needs a target it can actually hit, not a
              // 20px chip.
              onClick={
                moving
                  ? () => {
                      const m = moving;
                      setMoving(null);
                      void reschedule(m.id, dayIso, m.start);
                    }
                  : undefined
              }
              className={`rounded-md border min-h-48 flex flex-col ${
                moving ? "cursor-pointer ring-2 ring-inset ring-amber-400/60 hover:bg-amber-50/40" : ""
              } ${isToday ? "border-emerald-400 bg-emerald-50/20" : "border-slate-200"}`}
            >
              <div className="px-2 py-1.5 border-b border-slate-100 text-xs font-medium text-slate-600 flex items-center justify-between">
                <span>{day.toLocaleDateString(undefined, { weekday: "short" })}</span>
                <span className="tabular text-slate-400">{day.getDate()}</span>
              </div>
              {/* PTO badges */}
              {dayPto.map((t) => (
                <div key={t.id} className="mx-1 mt-1 rounded bg-slate-200/70 text-slate-700 text-[10px] px-1.5 py-0.5">
                  PTO · {t.clinicianName ?? t.clinicianUserId.slice(0, 6)}
                </div>
              ))}
              <ul className="flex-1 p-1 space-y-1">
                {dayVisits.map((v) => (
                  <li key={v.id}>
                    <div
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/visit-id", v.id);
                        e.dataTransfer.setData("text/visit-start", v.scheduledStart ?? "");
                      }}
                      title={[
                        v.patientName ?? "Patient",
                        v.patientCity ? `· ${v.patientCity}` : "",
                        `· ${v.visitType.replace(/_/g, " ")}`,
                        v.totalMinutes ? `· ${v.totalMinutes} min` : "",
                        v.clinicianName ? `· ${v.clinicianName}` : "",
                      ].filter(Boolean).join(" ")}
                      className={`visit-chip rounded px-1.5 py-1 text-[11px] cursor-grab active:cursor-grabbing ring-1 ring-inset ${
                        moving?.id === v.id ? "ring-2 ring-amber-500" : ""
                      } ${providerColor(v.clinicianUserId)}`}
                    >
                      {/*
                        The move affordance is its own button rather than the
                        whole chip, because the chip also holds a link and
                        nesting a link inside a button is invalid. Picking up
                        and putting down are the same gesture on a touch
                        screen, so this toggles. stopPropagation keeps the tap
                        off the day column, which is the drop target while a
                        move is in flight.
                      */}
                      <button
                        type="button"
                        aria-pressed={moving?.id === v.id}
                        aria-label={`Move ${v.patientName ?? "visit"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoving((cur) =>
                            cur?.id === v.id
                              ? null
                              : {
                                  id: v.id,
                                  label: v.patientName ?? v.visitType.replace(/_/g, " "),
                                  start: v.scheduledStart ?? null,
                                },
                          );
                        }}
                        className="w-full text-left"
                      >
                        <span className="flex items-center justify-between gap-1">
                          <span className="tabular font-medium">{timeOf(v.scheduledStart ?? v.startTime)}</span>
                          {v.isTelehealth && <span className="text-[9px]">📹</span>}
                        </span>
                        <span className="block truncate">{v.patientName ?? v.visitType.replace(/_/g, " ")}</span>
                        {v.patientCity && (
                          <span className="block truncate text-[10px] opacity-70">{v.patientCity}</span>
                        )}
                      </button>
                      <Link
                        href={`/visits/${v.id}/document`}
                        className="text-[10px] underline opacity-80"
                        onClick={(e) => e.stopPropagation()}
                      >
                        open
                      </Link>
                    </div>
                  </li>
                ))}
                {/* External (Google) busy blocks */}
                {dayBusy.map((b, i) => (
                  <li key={`busy-${i}`}>
                    <div
                      title={`External: ${b.summary}`}
                      className="rounded px-1.5 py-1 text-[10px] bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-300/50 border-dashed"
                    >
                      <span className="tabular">{timeOf(b.start)}</span> · {b.summary}
                    </div>
                  </li>
                ))}
                {dayVisits.length === 0 && dayBusy.length === 0 && (
                  <li className="text-[10px] text-slate-300 px-1.5 py-2">—</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Deterministic provider color from the clinician id (no lib). */
function providerColor(userId: string): string {
  const palette = [
    "bg-sky-100 text-sky-900 ring-sky-300/50",
    "bg-violet-100 text-violet-900 ring-violet-300/50",
    "bg-amber-100 text-amber-900 ring-amber-300/50",
    "bg-emerald-100 text-emerald-900 ring-emerald-300/50",
    "bg-rose-100 text-rose-900 ring-rose-300/50",
    "bg-teal-100 text-teal-900 ring-teal-300/50",
    "bg-indigo-100 text-indigo-900 ring-indigo-300/50",
  ];
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[h % palette.length]!;
}

function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isoDay(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The clinician list for both composers comes from loadClinicianOptions
// (lib/features/schedule/clinician-options.ts): the roster for someone who can
// see it, otherwise just themselves. See that file for why.

function PtoComposer({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [form, setForm] = useState({ clinicianUserId: "", startDate: "", endDate: "", reason: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // active=1, like the care-team pickers: offer only people the server will
    // accept. createTimeOff now refuses a clinician who is not an active
    // member of this org, so this keeps the picker and the rule in step —
    // before it did, a removed member offered here was booked off work on a
    // roster they were no longer on, and nobody was told.
    void loadClinicianOptions().then((opts) => {
      setMembers(opts);
      // Someone who may only book their own leave has exactly one choice.
      if (opts.length === 1) setForm((f) => ({ ...f, clinicianUserId: opts[0]!.userId }));
    });
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const r = await fetch("/api/time-off", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const d = await r.json();
    setSubmitting(false);
    if (!d.success) { setError(d.error ?? "Failed."); return; }
    onCreated();
  }
  return (
    <Card className="mb-6 border-slate-300">
      <CardHeader><CardTitle>Add PTO</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <Field label="Clinician" required>
            <select required value={form.clinicianUserId}
              onChange={(e) => setForm({ ...form, clinicianUserId: e.target.value })}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white">
              <option value="">Select…</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.fullName ?? m.email}</option>)}
            </select>
          </Field>
          <Field label="Start" required>
            <input required type="date" value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm" />
          </Field>
          <Field label="End" required>
            <input required type="date" value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm" />
          </Field>
          {/* reason was collected in state + sent to the API but had no input */}
          <Field label="Reason">
            <input value={form.reason} placeholder="e.g. vacation, sick"
              maxLength={200}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting || !form.clinicianUserId}>Add</Button>
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          </div>
          {error && <p className="text-red-700 text-sm md:col-span-4">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

function NewVisitComposer({
  defaultPatientId,
  onCreated,
  onCancel,
}: {
  defaultPatientId: string;
  onCreated: (visitId: string) => void;
  onCancel: () => void;
}) {
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  // The org's own types, not the five built-in coding bands (client
  // walkthrough 02:30 — "agar koi visit type ho raha hai jo hum ne add karna hai").
  // isTelehealth: the type forces telehealth (audit R22). codingBasis: the CPT
  // band it bills as, which the history note below is judged against.
  const [visitTypes, setVisitTypes] = useState<
    { slug: string; label: string; codingBasis: VisitType; isTelehealth?: boolean }[]
  >([]);
  // No visit type is chosen for the scheduler. This started on
  // "established_patient_home" and kept it whenever the org had that slug —
  // every seeded org does — so from a chart's "Schedule visit" link, with the
  // patient and the clinician's own name filled in, one click booked an
  // established visit, and a first visit was coded on the established ladder.
  const [form, setForm] = useState({
    patientId: defaultPatientId,
    clinicianUserId: "",
    visitType: "",
    scheduledStart: defaultDateTimeLocal(),
    isTelehealth: false,
    telehealthModality: "audio_video" as (typeof TELEHEALTH_MODALITIES)[number],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Pallio's own history for this patient before the time being booked, and
   * the patient + time it was asked for — a hint for another patient or date
   * is never shown against this one.
   */
  const [history, setHistory] = useState<{ key: string; hint: VisitTypeHint } | null>(null);

  useEffect(() => {
    void Promise.all([
      // 200 is the API's max limit — 500 was rejected with a 400, leaving the
      // patient dropdown empty and the composer unusable.
      fetch("/api/patients?limit=200").then((r) => r.json()),
      // active=1: scheduleVisit refuses a clinician who is not an active
      // member of this org, so the picker offers exactly who the server will
      // take. Before either existed, a visit could be assigned to a member who
      // was no longer active and then belonged to someone who could not open it.
      // Falls back to the signed-in clinician alone when they cannot see the
      // roster — see loadClinicianOptions.
      loadClinicianOptions(),
      fetch("/api/settings/visit-types").then((r) => r.json()),
    ]).then(([p, opts, t]) => {
      if (p.success) setPatients(p.data?.rows ?? []);
      setMembers(opts);
      if (opts.length === 1) setForm((f) => ({ ...f, clinicianUserId: opts[0]!.userId }));
      // The types only. None is picked: which one is right depends on whether
      // the practice has seen this patient, which is the scheduler's call.
      if (t.success) setVisitTypes(t.data?.types ?? []);
    });
  }, []);

  // What Pallio has on this patient before the time being booked. Debounced,
  // because every answer is a read of the patient's history and is logged as
  // PHI access; a refusal or a failure shows nothing rather than an error.
  const historyKey = `${form.patientId}|${form.scheduledStart}`;
  useEffect(() => {
    const at = new Date(form.scheduledStart);
    if (!form.patientId || Number.isNaN(at.getTime())) return;
    let abandoned = false;
    const timer = setTimeout(() => {
      fetch(
        `/api/patients/${form.patientId}/visit-type-hint?at=${encodeURIComponent(at.toISOString())}`,
      )
        .then((r) => r.json())
        .then((d) => {
          if (!abandoned && d?.success) setHistory({ key: historyKey, hint: d.data as VisitTypeHint });
        })
        .catch(() => {
          /* no hint is a safe answer: nothing is chosen for them either way */
        });
    }, 300);
    return () => {
      abandoned = true;
      clearTimeout(timer);
    };
  }, [form.patientId, form.scheduledStart, historyKey]);
  const hint = history?.key === historyKey ? history.hint : null;
  const chosenBasis = visitTypes.find((t) => t.slug === form.visitType)?.codingBasis;
  const mismatch = chosenBasis ? visitTypeHistoryWarning(chosenBasis, hint) : null;

  // A telehealth visit type forces the box on (audit R22); scheduleVisit does
  // the same server-side. Derived rather than written into form, so picking
  // an in-person type again restores whatever the clinician had chosen.
  const typeForcesTelehealth = visitTypes.some(
    (t) => t.slug === form.visitType && t.isTelehealth === true,
  );
  const telehealth = form.isTelehealth || typeForcesTelehealth;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const body = {
      patientId: form.patientId,
      clinicianUserId: form.clinicianUserId,
      visitType: form.visitType,
      scheduledStart: new Date(form.scheduledStart).toISOString(),
      isTelehealth: telehealth,
      ...(telehealth ? { telehealthModality: form.telehealthModality } : {}),
    };
    const res = await fetch("/api/visits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    // Phase E — 409 means Google Calendar reports overlap. Offer to
    // override and resubmit with confirmDoubleBook=true.
    if (res.status === 409) {
      const ok = window.confirm(
        `${data.error ?? "Conflict with existing Google Calendar events."}\n\nSchedule anyway?`,
      );
      if (ok) {
        const res2 = await fetch("/api/visits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, confirmDoubleBook: true }),
        });
        const data2 = await res2.json();
        setSubmitting(false);
        if (!data2.success) {
          setError(data2.error ?? "Schedule failed.");
          return;
        }
        onCreated(data2.data.id);
        return;
      }
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    if (!data.success) {
      setError(data.error ?? "Schedule failed.");
      return;
    }
    onCreated(data.data.id);
  }

  return (
    <Card className="mb-6 border-[var(--color-brand-600)]">
      <CardHeader>
        <CardTitle>New visit</CardTitle>
        <CardDescription>
          Pick a patient + clinician + visit type + time. Toggle telehealth to add modality.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Patient" required>
              <select
                required
                value={form.patientId}
                onChange={(e) => setForm({ ...form, patientId: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
              >
                <option value="">Select…</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>
                ))}
              </select>
            </Field>
            <Field label="Clinician" required>
              <select
                required
                value={form.clinicianUserId}
                onChange={(e) => setForm({ ...form, clinicianUserId: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
              >
                <option value="">Select…</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>{m.fullName ?? m.email}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Field label="Visit type" required>
                <select
                  required
                  value={form.visitType}
                  onChange={(e) => setForm({ ...form, visitType: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
                >
                  <option value="" disabled>Choose a visit type…</option>
                  {visitTypes.map((t) => (
                    <option key={t.slug} value={t.slug}>{t.label}</option>
                  ))}
                </select>
              </Field>
              {/* Advisory only: Pallio cannot see visits from before the
                  practice used it, so this never picks or blocks a type. */}
              {hint && <p className="mt-1 text-xs text-slate-600">{historyLine(hint)}</p>}
              {hint && mismatch && (
                <p className="mt-1 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900 ring-1 ring-inset ring-amber-600/30">
                  {mismatchLine(mismatch, hint)}
                </p>
              )}
            </div>
            <Field label="Scheduled start" required>
              <input
                required
                type="datetime-local"
                value={form.scheduledStart}
                onChange={(e) => setForm({ ...form, scheduledStart: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </Field>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={telehealth}
                disabled={typeForcesTelehealth}
                onChange={(e) => setForm({ ...form, isTelehealth: e.target.checked })}
              />
              <span>Telehealth</span>
              {typeForcesTelehealth && (
                <span className="text-xs text-slate-500">Set by the visit type</span>
              )}
            </label>
            {telehealth && (
              <select
                value={form.telehealthModality}
                onChange={(e) => setForm({ ...form, telehealthModality: e.target.value as typeof form.telehealthModality })}
                className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white"
              >
                {TELEHEALTH_MODALITIES.map((m) => (
                  <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
                ))}
              </select>
            )}
          </div>

          {error && (
            <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button
              type="submit"
              disabled={submitting || !form.patientId || !form.clinicianUserId || !form.visitType}
            >
              {submitting ? "Scheduling…" : "Schedule visit"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  required,
  optional,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-700 mb-1">
        {label}
        <FieldMarker required={required} optional={optional} />
      </span>
      {children}
    </label>
  );
}

function defaultDateTimeLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The date of an earlier visit, as the history lines name it. */
function hintDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * What Pallio's history says, in one line under the Visit type select. The
 * no-history line names outside records on purpose: a patient the practice saw
 * in its previous EHR is established, and Pallio cannot see that.
 */
function historyLine(h: VisitTypeHint): string {
  if (!h.lastVisitAt) {
    return `No visit for this patient in Pallio in the ${NEW_PATIENT_LOOKBACK_YEARS} years before this date — a New patient type fits. If your practice saw them outside Pallio (e.g. the previous EHR) in that time, choose an Established type.`;
  }
  if (h.lastVisitStatus === "scheduled") {
    return `Booked in this practice for ${hintDate(h.lastVisitAt)} — if that visit takes place, this one is Established.`;
  }
  return `Seen in this practice on ${hintDate(h.lastVisitAt)} — an Established type fits.`;
}

/** The amber note when the chosen type's band and Pallio's history disagree. */
function mismatchLine(kind: "looks_new" | "looks_established", h: VisitTypeHint): string {
  if (kind === "looks_new" || !h.lastVisitAt) {
    return `Pallio has no visit for this patient in the ${NEW_PATIENT_LOOKBACK_YEARS} years before this date. If your practice has not seen them in that time either, this is a New patient visit.`;
  }
  return `${h.lastVisitStatus === "scheduled" ? "Booked for" : "Seen on"} ${hintDate(h.lastVisitAt)}: payers treat a new-patient code within ${NEW_PATIENT_LOOKBACK_YEARS} years of a visit by this practice as established.`;
}

function timeOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
