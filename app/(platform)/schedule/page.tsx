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
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TELEHEALTH_MODALITIES,
  VISIT_TYPES,
  type VisitView,
} from "@/lib/features/visits/visit.types";

interface PatientOption { id: string; firstName: string; lastName: string }
interface MemberOption  { userId: string; email: string; fullName: string | null }

export default function SchedulePage() {
  return (
    <Suspense fallback={null}>
      <ScheduleInner />
    </Suspense>
  );
}

interface ExternalBusy { summary: string; start: string; end: string; userId: string | null }
interface TimeOffEntry { id: string; clinicianUserId: string; clinicianName: string | null; startDate: string; endDate: string; reason: string | null }

function ScheduleInner() {
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
  const params = useSearchParams();
  const preselectPatientId = params.get("patientId") ?? "";

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
    void reload();
    if (preselectPatientId) setComposing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectPatientId, weekStart]);

  async function reschedule(visitId: string, dayIso: string, originalIso: string | null) {
    // Keep the original time-of-day, move to the dropped day.
    const orig = originalIso ? new Date(originalIso) : new Date();
    const target = new Date(`${dayIso}T00:00:00`);
    target.setHours(orig.getHours(), orig.getMinutes(), 0, 0);
    const r = await fetch(`/api/visits/${visitId}/reschedule`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduledStart: target.toISOString() }),
    });
    const d = await r.json();
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
      const day = ts.slice(0, 10);
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
            Week of {weekStart.toLocaleDateString(undefined, { month: "long", day: "numeric" })}.
            Drag a visit to another day to reschedule.
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

      <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
        {days.map((day) => {
          const dayIso = isoDay(day);
          const dayVisits = (byDay.get(dayIso) ?? []).sort((a, b) =>
            (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""),
          );
          const dayPto = timeOff.filter((t) => dayIso >= t.startDate && dayIso <= t.endDate);
          const dayBusy = externalBusy.filter((b) => b.start.slice(0, 10) === dayIso);
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
              className={`rounded-md border min-h-48 flex flex-col ${isToday ? "border-emerald-400 bg-emerald-50/20" : "border-slate-200"}`}
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
                      className={`rounded px-1.5 py-1 text-[11px] cursor-grab active:cursor-grabbing ring-1 ring-inset ${providerColor(v.clinicianUserId)}`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="tabular font-medium">{timeOf(v.scheduledStart ?? v.startTime)}</span>
                        {v.isTelehealth && <span className="text-[9px]">📹</span>}
                      </div>
                      <div className="truncate">{v.patientName ?? v.visitType.replace(/_/g, " ")}</div>
                      {v.patientCity && <div className="truncate text-[10px] opacity-70">{v.patientCity}</div>}
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

function PtoComposer({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [form, setForm] = useState({ clinicianUserId: "", startDate: "", endDate: "", reason: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/team/members").then((r) => r.json()).then((m) => {
      if (m.success) setMembers(m.data?.rows ?? []);
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
  const [form, setForm] = useState({
    patientId: defaultPatientId,
    clinicianUserId: "",
    visitType: "established_patient_home" as (typeof VISIT_TYPES)[number],
    scheduledStart: defaultDateTimeLocal(),
    isTelehealth: false,
    telehealthModality: "audio_video" as (typeof TELEHEALTH_MODALITIES)[number],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      // 200 is the API's max limit — 500 was rejected with a 400, leaving the
      // patient dropdown empty and the composer unusable.
      fetch("/api/patients?limit=200").then((r) => r.json()),
      fetch("/api/team/members").then((r) => r.json()),
    ]).then(([p, m]) => {
      if (p.success) setPatients(p.data?.rows ?? []);
      if (m.success) setMembers(m.data?.rows ?? []);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const body = {
      patientId: form.patientId,
      clinicianUserId: form.clinicianUserId,
      visitType: form.visitType,
      scheduledStart: new Date(form.scheduledStart).toISOString(),
      isTelehealth: form.isTelehealth,
      ...(form.isTelehealth ? { telehealthModality: form.telehealthModality } : {}),
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
          Pick a patient + clinician + time. Toggle telehealth to add modality.
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
            <Field label="Visit type" required>
              <select
                value={form.visitType}
                onChange={(e) => setForm({ ...form, visitType: e.target.value as typeof form.visitType })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
              >
                {VISIT_TYPES.map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </select>
            </Field>
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
                checked={form.isTelehealth}
                onChange={(e) => setForm({ ...form, isTelehealth: e.target.checked })}
              />
              <span>Telehealth</span>
            </label>
            {form.isTelehealth && (
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
              disabled={submitting || !form.patientId || !form.clinicianUserId}
            >
              {submitting ? "Scheduling…" : "Schedule visit"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-700 mb-1">
        {label}
        {required && <span className="text-red-600 ml-0.5">*</span>}
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

function timeOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
