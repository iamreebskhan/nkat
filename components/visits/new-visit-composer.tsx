/**
 * The new-visit form: patient, clinician, visit type, time, telehealth.
 *
 * The schedule page's composer, moved here so the visit screen can book the
 * next visit while the clinician is still with the patient (Level-1 doc:42).
 * From a visit the patient is fixed and the clinician and a time two weeks on
 * are filled in; the visit type is still left to the person booking, for the
 * reason below.
 */
"use client";

import { useEffect, useState } from "react";

import { FieldMarker } from "@/components/forms/field-marker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authGapOn } from "@/lib/features/billing/prior-auth";
import { orgInstant, orgLocalInput } from "@/lib/features/org/org-date";
import { fetchAllPatients } from "@/lib/features/patients/patient-picker";
import { loadClinicianOptions } from "@/lib/features/schedule/clinician-options";
import { usePracticeZone } from "@/lib/features/schedule/use-practice-zone";
import { hintDayLabel, visitTypeHistoryWarning } from "@/lib/features/visits/visit-pure";
import { seriesDays, seriesProblem, type SeriesConflict } from "@/lib/features/visits/visit-series";
import {
  NEW_PATIENT_LOOKBACK_YEARS,
  TELEHEALTH_MODALITIES,
  type SeriesUnit,
  type VisitType,
  type VisitTypeHint,
} from "@/lib/features/visits/visit.types";

interface PatientOption { id: string; firstName: string; lastName: string }
interface MemberOption  { userId: string; email: string; fullName: string | null }

/** How often a visit repeats: the choices offered, as every N units. */
const REPEATS: { value: string; label: string; every: number; unit: SeriesUnit }[] = [
  { value: "1w", label: "Every week", every: 1, unit: "week" },
  { value: "2w", label: "Every 2 weeks", every: 2, unit: "week" },
  { value: "3w", label: "Every 3 weeks", every: 3, unit: "week" },
  { value: "4w", label: "Every 4 weeks", every: 4, unit: "week" },
  { value: "1m", label: "Every month", every: 1, unit: "month" },
];

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function NewVisitComposer({
  defaultPatientId,
  lockedPatient,
  defaultClinicianUserId,
  defaultStartAt,
  title = "New visit",
  description = "Pick a patient + clinician + visit type + time. Toggle telehealth to add modality.",
  onCreated,
  onCancel,
}: {
  defaultPatientId?: string;
  /** Book for this patient only: no patient picker. */
  lockedPatient?: { id: string; name: string };
  /** Pre-picked when this member is on the roster offered. */
  defaultClinicianUserId?: string;
  /** The instant to start from; the next hour when absent. */
  defaultStartAt?: string;
  title?: string;
  description?: string;
  onCreated: (visitId: string, at: { scheduledStart: string; clinicianName: string | null; visits: number }) => void;
  onCancel: () => void;
}) {
  // The time typed is on the practice's clock, wherever the person typing is.
  const zone = usePracticeZone();
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [patientsError, setPatientsError] = useState<string | null>(null);
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
    patientId: lockedPatient?.id ?? defaultPatientId ?? "",
    clinicianUserId: "",
    visitType: "",
    isTelehealth: false,
    telehealthModality: "audio_video" as (typeof TELEHEALTH_MODALITIES)[number],
  });
  const [repeat, setRepeat] = useState({ pattern: "", ends: "count" as "count" | "until", count: "6", until: "" });
  // The days of a series that need a person's eye: nothing is booked yet.
  const [conflicts, setConflicts] = useState<SeriesConflict[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What was typed, else where it starts once the practice's clock is known.
  const zoneId = zone?.timeZone;
  const [typedStart, setTypedStart] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  const scheduledStart = typedStart ?? (zoneId ? defaultDateTimeLocal(zoneId, defaultStartAt ?? openedAt) : "");
  /**
   * Pallio's own history for this patient before the time being booked, and
   * the patient + time it was asked for — a hint for another patient or date
   * is never shown against this one.
   */
  const [history, setHistory] = useState<{ key: string; hint: VisitTypeHint } | null>(null);
  const [auths, setAuths] = useState<{ patientId: string; list: Parameters<typeof authGapOn>[0] } | null>(null);

  // By id, not by the object: a parent passing a fresh object each render
  // would otherwise re-run the effect, and its fetches, on every one.
  const lockedPatientId = lockedPatient?.id;
  useEffect(() => {
    // Every patient under care, page by page: one page of 200 left the rest
    // unbookable. Not needed when the patient is fixed. A list that could not
    // be read says so under the field rather than offering nobody.
    if (!lockedPatientId) {
      fetchAllPatients()
        .then((rows) => {
          setPatients(rows);
          setPatientsError(null);
        })
        .catch((e: unknown) =>
          setPatientsError(e instanceof Error ? e.message : "The patient list could not be loaded."),
        );
    }
    void Promise.all([
      // active=1: scheduleVisit refuses a clinician who is not an active
      // member of this org, so the picker offers exactly who the server will
      // take. Before either existed, a visit could be assigned to a member who
      // was no longer active and then belonged to someone who could not open it.
      // Falls back to the signed-in clinician alone when they cannot see the
      // roster — see loadClinicianOptions.
      loadClinicianOptions(),
      fetch("/api/settings/visit-types").then((r) => r.json()),
    ]).then(([opts, t]) => {
      setMembers(opts);
      const preset = defaultClinicianUserId && opts.find((m) => m.userId === defaultClinicianUserId);
      if (preset) setForm((f) => ({ ...f, clinicianUserId: preset.userId }));
      else if (opts.length === 1) setForm((f) => ({ ...f, clinicianUserId: opts[0]!.userId }));
      // The types only. None is picked: which one is right depends on whether
      // the practice has seen this patient, which is the scheduler's call.
      if (t.success) setVisitTypes(t.data?.types ?? []);
    });
  }, [lockedPatientId, defaultClinicianUserId]);

  // What Pallio has on this patient before the time being booked. Debounced,
  // because every answer is a read of the patient's history and is logged as
  // PHI access; a refusal or a failure shows nothing rather than an error.
  const historyKey = `${form.patientId}|${scheduledStart}`;
  useEffect(() => {
    if (!form.patientId || !zoneId || !scheduledStart) return;
    const at = orgInstant(scheduledStart, zoneId);
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
  }, [form.patientId, scheduledStart, historyKey, zoneId]);
  const hint = history?.key === historyKey ? history.hint : null;

  // Authorizations on the chart (0124), to say when one has run out or not yet
  // begun on the day being booked. Advisory: a refusal shows nothing.
  useEffect(() => {
    if (!form.patientId) return;
    let abandoned = false;
    fetch(`/api/patients/${form.patientId}/prior-auths`)
      .then((r) => r.json())
      .then((d) => {
        if (!abandoned && d?.success) setAuths({ patientId: form.patientId, list: d.data.auths });
      })
      .catch(() => {});
    return () => {
      abandoned = true;
    };
  }, [form.patientId]);
  const authGap =
    auths?.patientId === form.patientId && scheduledStart ? authGapOn(auths.list, scheduledStart.slice(0, 10)) : null;
  const chosenBasis = visitTypes.find((t) => t.slug === form.visitType)?.codingBasis;
  const mismatch = chosenBasis ? visitTypeHistoryWarning(chosenBasis, hint) : null;

  // A telehealth visit type forces the box on (audit R22); scheduleVisit does
  // the same server-side. Derived rather than written into form, so picking
  // an in-person type again restores whatever the clinician had chosen.
  const typeForcesTelehealth = visitTypes.some(
    (t) => t.slug === form.visitType && t.isTelehealth === true,
  );
  const telehealth = form.isTelehealth || typeForcesTelehealth;

  // What the repeat asks for, and what it comes to, the rule the server books by.
  const pattern = REPEATS.find((r) => r.value === repeat.pattern);
  const count = /^\d+$/.test(repeat.count) ? Number(repeat.count) : null;
  const days = pattern && scheduledStart
    ? seriesDays({
        first: scheduledStart.slice(0, 10),
        every: pattern.every,
        unit: pattern.unit,
        ...(repeat.ends === "count" ? { count } : { until: repeat.until || null, count: repeat.until ? null : 1 }),
      })
    : [];
  const repeatProblem = pattern ? seriesProblem(days) : null;

  async function submitSeries(extra: { skipDays?: string[]; confirmDoubleBook?: boolean } = {}) {
    if (!pattern || !zoneId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/visits/series", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patientId: form.patientId,
          clinicianUserId: form.clinicianUserId,
          visitType: form.visitType,
          startLocal: scheduledStart,
          isTelehealth: telehealth,
          ...(telehealth ? { telehealthModality: form.telehealthModality } : {}),
          every: pattern.every,
          unit: pattern.unit,
          ...(repeat.ends === "count" ? { count: count ?? 0 } : { until: repeat.until }),
          ...extra,
        }),
      });
      const d = await res.json();
      if (!d.success) return setError(d.error ?? "Schedule failed.");
      if (d.data.conflicts.length > 0) return setConflicts(d.data.conflicts);
      const first = d.data.booked[0];
      const m = members.find((x) => x.userId === form.clinicianUserId);
      onCreated(first.id, { scheduledStart: first.start, clinicianName: m ? (m.fullName ?? m.email) : null, visits: d.data.booked.length });
    } catch {
      setError("Network error — the visits may not have been booked. Check the weeks ahead before trying again, so they are not booked twice.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!zoneId) return;
    if (pattern) return submitSeries();
    setSubmitting(true);
    setError(null);
    const body = {
      patientId: form.patientId,
      clinicianUserId: form.clinicianUserId,
      visitType: form.visitType,
      scheduledStart: orgInstant(scheduledStart, zoneId).toISOString(),
      isTelehealth: telehealth,
      ...(telehealth ? { telehealthModality: form.telehealthModality } : {}),
    };
    // A failed request ends the same way as a refused one: the button comes
    // back and the form says so. A thrown fetch — no signal in a patient's
    // home — used to leave "Scheduling…" on screen for good, with no word on
    // whether the visit had been booked.
    let createdId: string | null = null;
    try {
      const res = await fetch("/api/visits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      // 409: the clinician's day is at capacity, or Google Calendar reports
      // an overlap. Offer to override and resubmit with confirmDoubleBook=true.
      if (res.status === 409) {
        const ok = window.confirm(
          `${data.error ?? "Conflict with existing Google Calendar events."}\n\nSchedule anyway?`,
        );
        if (!ok) return;
        const res2 = await fetch("/api/visits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, confirmDoubleBook: true }),
        });
        const data2 = await res2.json();
        if (!data2.success) {
          setError(data2.error ?? "Schedule failed.");
          return;
        }
        createdId = data2.data.id;
      } else if (!data.success) {
        setError(data.error ?? "Schedule failed.");
        return;
      } else {
        createdId = data.data.id;
      }
    } catch {
      setError(
        "Network error — the visit may not have been booked. Check the week before trying again, so it is not booked twice.",
      );
      return;
    } finally {
      setSubmitting(false);
    }
    if (createdId) {
      const m = members.find((x) => x.userId === form.clinicianUserId);
      onCreated(createdId, { scheduledStart: body.scheduledStart, clinicianName: m ? (m.fullName ?? m.email) : null, visits: 1 });
    }
  }

  return (
    <Card className="mb-6 border-[var(--color-brand-600)]">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" aria-label={title}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {lockedPatient ? (
              <div>
                <span className="block text-xs font-medium text-slate-700 mb-1">Patient</span>
                <p className="py-2 text-sm text-slate-900">{lockedPatient.name}</p>
              </div>
            ) : (
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
                {patientsError && (
                  <p role="alert" className="mt-1 text-xs text-red-700">
                    {patientsError} Close the form and open it again to retry.
                  </p>
                )}
              </Field>
            )}
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
            <div>
              <Field label={`Scheduled start${zone ? ` (${zone.zoneName})` : ""}`} required>
                <input
                  required
                  type="datetime-local"
                  value={scheduledStart}
                  onChange={(e) => {
                    setConflicts(null);
                    setTypedStart(e.target.value);
                  }}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
              {zone?.differs && (
                <p className="mt-1 text-xs text-slate-600">
                  On the practice&rsquo;s clock ({zone.timeZone.replace(/_/g, " ")}), not this computer&rsquo;s.
                </p>
              )}
              {authGap && (
                <p role="status" className="mt-1 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900 ring-1 ring-inset ring-amber-600/30">
                  {authGap}
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Repeats" optional>
              <select
                value={repeat.pattern}
                onChange={(e) => {
                  setConflicts(null);
                  setRepeat({ ...repeat, pattern: e.target.value });
                }}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
              >
                <option value="">Does not repeat</option>
                {REPEATS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </Field>
            {pattern && (
              <Field label="Ends" required>
                <select
                  value={repeat.ends}
                  onChange={(e) => {
                    setConflicts(null);
                    setRepeat({ ...repeat, ends: e.target.value as "count" | "until" });
                  }}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
                >
                  <option value="count">After a number of visits</option>
                  <option value="until">On a date</option>
                </select>
              </Field>
            )}
            {pattern && repeat.ends === "count" && (
              <Field label="Number of visits" required>
                <input
                  inputMode="numeric"
                  value={repeat.count}
                  onChange={(e) => {
                    setConflicts(null);
                    setRepeat({ ...repeat, count: e.target.value });
                  }}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
            )}
            {pattern && repeat.ends === "until" && (
              <Field label="Last day" required>
                <input
                  type="date"
                  value={repeat.until}
                  onChange={(e) => {
                    setConflicts(null);
                    setRepeat({ ...repeat, until: e.target.value });
                  }}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
            )}
          </div>
          {pattern && (
            <p role="status" className={`text-xs ${repeatProblem ? "text-red-700" : "text-slate-600"}`}>
              {repeatProblem ?? `${days.length} visits, ${dayLabel(days[0]!)} to ${dayLabel(days.at(-1)!)}. Each one can be moved or cancelled on its own afterwards.`}
            </p>
          )}
          {conflicts && (
            <div role="alert" className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/30">
              <p className="font-medium">
                {conflicts.length === 1 ? "One day needs a look." : `${conflicts.length} days need a look.`} Nothing is booked yet.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {conflicts.map((c) => (
                  <li key={c.day}>{dayLabel(c.day)}: {c.detail}</li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={submitting} onClick={() => void submitSeries({ skipDays: conflicts.map((c) => c.day) })}>
                  Leave those days out
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={submitting} onClick={() => void submitSeries({ confirmDoubleBook: true })}>
                  Book them anyway
                </Button>
              </div>
            </div>
          )}
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
              disabled={submitting || !zone || !scheduledStart || !form.patientId || !form.clinicianUserId || !form.visitType || Boolean(repeatProblem)}
            >
              {submitting ? "Scheduling…" : pattern && !repeatProblem ? `Schedule ${days.length} visits` : "Schedule visit"}
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

/** Where the time starts, on the practice's clock: the instant given, or the next hour after a moment. */
function defaultDateTimeLocal(timeZone: string, from: string | number): string {
  if (typeof from === "string") return orgLocalInput(from, timeZone);
  const hour = 60 * 60_000;
  return orgLocalInput(new Date(Math.ceil(from / hour) * hour), timeZone);
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
    return `Booked in this practice for ${hintDayLabel(h)} — if that visit takes place, this one is Established.`;
  }
  return `Seen in this practice on ${hintDayLabel(h)} — an Established type fits.`;
}

/** The amber note when the chosen type's band and Pallio's history disagree. */
function mismatchLine(kind: "looks_new" | "looks_established", h: VisitTypeHint): string {
  if (kind === "looks_new" || !h.lastVisitAt) {
    return `Pallio has no visit for this patient in the ${NEW_PATIENT_LOOKBACK_YEARS} years before this date. If your practice has not seen them in that time either, this is a New patient visit.`;
  }
  return `${h.lastVisitStatus === "scheduled" ? "Booked for" : "Seen on"} ${hintDayLabel(h)}: payers treat a new-patient code within ${NEW_PATIENT_LOOKBACK_YEARS} years of a visit by this practice as established.`;
}
