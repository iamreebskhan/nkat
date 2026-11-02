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
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NewVisitComposer } from "@/components/visits/new-visit-composer";
import { orgClockTime, orgInstant, orgLocalDate, orgLocalInput } from "@/lib/features/org/org-date";
import { loadClinicianOptions } from "@/lib/features/schedule/clinician-options";
import { usePracticeZone } from "@/lib/features/schedule/use-practice-zone";
import { type VisitView } from "@/lib/features/visits/visit.types";

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
  // The board runs on the practice's clock, wherever the person using it is: a
  // visit happens where the practice is.
  const zone = usePracticeZone();
  const tz = zone?.timeZone;
  const practiceToday = zone?.today;
  // Weeks from this one; the Monday shown follows the practice's calendar.
  const [weekShift, setWeekShift] = useState(0);
  const weekStart = useMemo(
    () => addDays(mondayOf(practiceToday ? new Date(`${practiceToday}T00:00:00`) : new Date()), weekShift * 7),
    [practiceToday, weekShift],
  );

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
  }, [weekStart.getTime()]);

  async function reschedule(visitId: string, dayIso: string, originalIso: string | null) {
    if (!tz) return;
    // Keep the original time-of-day on the practice's clock, move to the dropped day.
    const time = orgLocalInput(originalIso ?? new Date(), tz).slice(11);
    const target = orgInstant(`${dayIso}T${time}`, tz);
    const send = (confirmDoubleBook: boolean) =>
      fetch(`/api/visits/${visitId}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scheduledStart: target.toISOString(),
          ...(confirmDoubleBook ? { confirmDoubleBook: true } : {}),
        }),
      });
    try {
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
    } catch {
      // Without this a dropped connection ended the move silently. Reload
      // either way, so the week shows where the visit actually is.
      alert("Network error — the visit may not have moved. The week is reloaded to show where it is.");
    }
    void reload();
  }

  const byDay = useMemo(() => {
    const map = new Map<string, VisitView[]>();
    for (const v of visits) {
      const ts = v.scheduledStart ?? v.startTime;
      if (!ts || !tz) continue;
      // The day on the practice's clock, which is what the columns and the
      // times on the chips are in, and what the printed route sheet files it
      // under. ts.slice(0, 10) was the UTC day: a 3 pm Ohio visit seen from
      // Karachi sat under Wednesday showing "0:00".
      const day = orgLocalDate(ts, tz);
      const arr = map.get(day) ?? [];
      arr.push(v);
      map.set(day, arr);
    }
    return map;
  }, [visits, tz]);

  const timeOf = (iso: string | null) => (iso && tz ? orgClockTime(iso, tz) : "—");

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
            {zone?.differs && ` Times are on the practice's clock (${zone.zoneName}), not this computer's.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setWeekShift((w) => w - 1)}>← Prev</Button>
          <Button variant="secondary" onClick={() => setWeekShift(0)}>This week</Button>
          <Button variant="secondary" onClick={() => setWeekShift((w) => w + 1)}>Next →</Button>
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
          onCreated={(visitId, at) => {
            setComposing(false);
            void reload();
            // One visit may be documented now; a series is for the weeks ahead.
            if (at.visits === 1 && confirm("Visit scheduled. Open documentation now?")) {
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
          // As the visits: the practice's day, not the UTC one. An all-day event
          // can arrive as a bare date, which is already the day.
          const dayBusy = externalBusy.filter(
            (b) => (/^\d{4}-\d{2}-\d{2}$/.test(b.start) ? b.start : tz ? orgLocalDate(b.start, tz) : null) === dayIso,
          );
          const isToday = dayIso === (practiceToday ?? isoDay(new Date()));
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
                          <span className="flex items-center gap-1">
                            {v.seriesId && <span title="Part of a repeating series" className="text-[9px]">↻</span>}
                            {v.isTelehealth && <span className="text-[9px]">📹</span>}
                          </span>
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
    // As the visit form above: a thrown fetch must not leave the button
    // spinning with no word on whether the time off was saved.
    try {
      const r = await fetch("/api/time-off", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (!d.success) { setError(d.error ?? "Failed."); return; }
    } catch {
      setError("Network error — the time off may not have been saved. Check the week before trying again.");
      return;
    } finally {
      setSubmitting(false);
    }
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


