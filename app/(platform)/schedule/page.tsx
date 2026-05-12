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

function ScheduleInner() {
  const [visits, setVisits] = useState<VisitView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const router = useRouter();
  const params = useSearchParams();
  const preselectPatientId = params.get("patientId") ?? "";

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/api/visits?status=scheduled&limit=200");
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Failed to load.");
        return;
      }
      setVisits(data.data.rows ?? []);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    if (preselectPatientId) setComposing(true);
  }, [preselectPatientId]);

  const grouped = useMemo(() => groupByDay(visits), [visits]);

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Schedule</h1>
          <p className="text-slate-600 mt-1">Upcoming visits across all clinicians.</p>
        </div>
        <Button onClick={() => setComposing((v) => !v)}>
          {composing ? "Close" : "New visit"}
        </Button>
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

      {loading && <p className="text-slate-500">Loading…</p>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {!loading && grouped.length === 0 && !composing && (
        <Card>
          <CardHeader>
            <CardTitle>No upcoming visits</CardTitle>
            <CardDescription>Click "New visit" above to schedule one.</CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="space-y-4">
        {grouped.map(({ date, items }) => (
          <Card key={date}>
            <CardHeader>
              <CardTitle className="text-lg tabular">{prettyDate(date)}</CardTitle>
              <CardDescription>
                {items.length} visit{items.length === 1 ? "" : "s"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-slate-100">
                {items.map((v) => (
                  <li key={v.id} className="py-2 flex items-center justify-between text-sm">
                    <div>
                      <span className="font-medium">{v.visitType.replace(/_/g, " ")}</span>
                      <span className="text-slate-500 tabular">
                        {" · "}{timeOf(v.scheduledStart ?? v.startTime)}
                      </span>
                      {v.isTelehealth && (
                        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">telehealth</span>
                      )}
                    </div>
                    <Link
                      href={`/visits/${v.id}/document`}
                      className="text-xs text-[var(--color-brand-700)] hover:underline"
                    >
                      Open →
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
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
      fetch("/api/patients?limit=500").then((r) => r.json()),
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

function groupByDay(visits: VisitView[]): { date: string; items: VisitView[] }[] {
  const map = new Map<string, VisitView[]>();
  for (const v of visits) {
    const ts = v.scheduledStart ?? v.startTime ?? v.createdAt;
    const day = ts.slice(0, 10);
    const arr = map.get(day) ?? [];
    arr.push(v);
    map.set(day, arr);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, items }));
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function timeOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
