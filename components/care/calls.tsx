/**
 * Between visits on the chart (0116; Level-1 doc:50-53): what the care plan
 * asks to be monitored and when each item is due, telephone encounters with
 * their symptom scores, and the form that records one. A call's scores are
 * checked against the NP's escalation parameters when it is saved, and its
 * minutes can count toward a PCM/CCM enrolment's month (0117), whose time and
 * charge are on the card below the calls.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CALL_DIRECTIONS,
  CALL_DIRECTION_LABEL,
  CARE_PROGRAM_SHORT,
  SPOKE_WITH,
  SPOKE_WITH_LABEL,
  type EnrollmentView,
  type PhoneEncounterView,
} from "@/lib/features/care-coordination/care-coordination.types";
import type { FollowUpView } from "@/lib/features/care-coordination/caseload.service";
import { MONITORING_HOW_LABEL } from "@/lib/features/care-plans/care-plan.types";

import { CareManagementCard } from "./care-management";
import { TaskForm } from "./tasks";

const SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** "2026-10-28T09:30" for a datetime-local input, in the browser's own zone. */
function localNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function CallsTab({
  patientId,
  canRecord,
  canVoid,
  canGiveTask,
  canRaiseCharge,
  canViewBill,
  onChanged,
}: {
  patientId: string;
  /** visits.create: a call is clinical documentation. */
  canRecord: boolean;
  /** visits.edit */
  canVoid: boolean;
  /** patients.edit */
  canGiveTask: boolean;
  /** visits.submit: a PCM/CCM month's charge is sent to billing as a signed visit is. */
  canRaiseCharge: boolean;
  /** billing.superbills.view */
  canViewBill: boolean;
  /** A saved call can raise an escalation alert: the chart's banner re-reads. */
  onChanged: () => void;
}) {
  const [followUp, setFollowUp] = useState<FollowUpView | null>(null);
  const [calls, setCalls] = useState<PhoneEncounterView[] | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentView[]>([]);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [taskFor, setTaskFor] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    Promise.all([
      fetch(`/api/patients/${patientId}/follow-up`).then((r) => r.json()),
      fetch(`/api/patients/${patientId}/calls`).then((r) => r.json()),
      fetch(`/api/patients/${patientId}/enrollments`).then((r) => r.json()),
    ])
      .then(([f, c, e]) => {
        if (abandoned) return;
        if (!f.success || !c.success) return setFailed(true);
        setFollowUp(f.data);
        setCalls(c.data.rows);
        // Without them a call simply counts toward nothing.
        setEnrollments(e.success ? e.data.rows : []);
        setFailed(false);
      })
      .catch(() => {
        if (!abandoned) setFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [patientId, version]);

  const reload = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  if (failed) return <p className="text-sm text-slate-500">Between-visit care could not be loaded.</p>;
  if (!followUp || !calls) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="grid grid-cols-1 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Follow-up</CardTitle>
          <CardDescription>
            What the care plan asks to be monitored between visits, and when each is due.{" "}
            <Link href={`/patients/${patientId}/care-plan`} className="text-[var(--color-brand-700)] hover:underline">
              Change it on the care plan →
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {followUp.monitoring.length === 0 ? (
            <p className="text-slate-500">The care plan asks for no monitoring between visits yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100" aria-label="Monitoring">
              {followUp.monitoring.map((m) => (
                <li key={m.item} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <span>
                    <span className="font-medium">{m.item}</span>
                    <span className="text-slate-500">
                      {" "}
                      · {MONITORING_HOW_LABEL[m.how]}
                      {m.everyDays ? `, every ${m.everyDays} day${m.everyDays === 1 ? "" : "s"}` : ", as needed"}
                    </span>
                  </span>
                  <span className="text-xs text-slate-600">
                    last {m.lastOn ?? "none yet"}
                    {m.dueOn && (
                      <>
                        {" · due "}
                        <span className={m.overdue ? "font-medium text-red-700" : m.dueOn <= followUp.today ? "font-medium text-amber-800" : ""}>
                          {m.dueOn}
                          {m.overdue ? " (overdue)" : m.dueOn === followUp.today ? " (today)" : ""}
                        </span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-500">
            Last visit {followUp.lastVisitOn ?? "none yet"} · last call {followUp.lastCallOn ?? "none yet"}
            {followUp.reviewOn && (
              <>
                {" · plan review "}
                <span className={followUp.reviewDue ? "font-medium text-amber-800" : ""}>
                  {followUp.reviewOn}
                  {followUp.reviewDue ? " (due)" : ""}
                </span>
              </>
            )}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle>Phone calls</CardTitle>
            <CardDescription>Telephone encounters between visits, with the symptom scores taken.</CardDescription>
          </div>
          {canRecord && !adding && (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Record a call
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {adding && (
            <CallForm
              patientId={patientId}
              inForce={enrollments.filter((e) => e.endedOn === null)}
              onCancel={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                reload();
              }}
            />
          )}
          {calls.length === 0 ? (
            <p className="text-slate-500">No calls recorded.</p>
          ) : (
            <ul className="divide-y divide-slate-100" aria-label="Phone calls">
              {calls.map((c) => (
                <li key={c.id} className={`py-2 ${c.voidedAt ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className={c.voidedAt ? "line-through" : ""}>
                      {/* Day and time both where the practice is: the day was the
                          practice's and the time the browser's, so a call at 11 pm
                          in Ohio read "2026-10-24 08:00" from Pakistan. */}
                      <strong className="tabular">
                        {c.occurredOn} {c.occurredTime}
                      </strong>
                      <span className="text-slate-500">
                        {" "}
                        · {CALL_DIRECTION_LABEL[c.direction]} · spoke with {SPOKE_WITH_LABEL[c.spokeWith].toLowerCase()}
                        {c.minutes ? ` · ${c.minutes} min` : ""}
                      </span>
                      {c.countedFor && (
                        <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
                          counts toward {CARE_PROGRAM_SHORT[c.countedFor]}
                        </span>
                      )}
                    </p>
                    {!c.voidedAt && voidingId !== c.id && (
                      <span className="flex gap-3">
                        {canGiveTask && (
                          <button type="button" className="text-xs text-slate-600 hover:text-slate-900" onClick={() => setTaskFor(c.id)}>
                            Give a task
                          </button>
                        )}
                        {canVoid && (
                          <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => setVoidingId(c.id)}>
                            Void
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {(c.painScore !== null || c.dyspneaScore !== null || c.nauseaScore !== null) && (
                    <p className="text-xs text-slate-600">
                      {[
                        c.painScore !== null && `Pain ${c.painScore}/10`,
                        c.dyspneaScore !== null && `Shortness of breath ${c.dyspneaScore}/10`,
                        c.nauseaScore !== null && `Nausea ${c.nauseaScore}/10`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap text-slate-700">{c.summary}</p>
                  <p className="text-xs text-slate-500">
                    {c.clinicianName ?? "Someone"}
                    {c.voidedAt && ` · voided: ${c.voidReason}`}
                  </p>
                  {voidingId === c.id && (
                    <VoidCall
                      patientId={patientId}
                      callId={c.id}
                      onCancel={() => setVoidingId(null)}
                      onVoided={() => {
                        setVoidingId(null);
                        reload();
                      }}
                    />
                  )}
                  {taskFor === c.id && (
                    <div className="mt-2">
                      <TaskForm
                        patientId={patientId}
                        phoneEncounterId={c.id}
                        today={followUp.today}
                        onCancel={() => setTaskFor(null)}
                        onSaved={() => setTaskFor(null)}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CareManagementCard
        patientId={patientId}
        canLog={canRecord}
        canVoid={canVoid}
        canRaise={canRaiseCharge}
        canViewBill={canViewBill}
        reloadKey={version}
        onChanged={() => setVersion((v) => v + 1)}
      />
    </div>
  );
}

function CallForm({
  patientId,
  inForce,
  onSaved,
  onCancel,
}: {
  patientId: string;
  /** The patient's PCM/CCM enrolments in force: what the minutes may count toward. */
  inForce: EnrollmentView[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState(() => ({
    at: localNow(), direction: "outbound", spokeWith: "", minutes: "", pain: "", dyspnea: "", nausea: "", summary: "",
    // One enrolment in force: its time, unless unticked. Two: the caller says which.
    countFor: inForce.length === 1 ? inForce[0]!.id : "",
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
  };
  const score = (v: string) => (v === "" ? undefined : Number(v));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!f.spokeWith) return setMsg("Who did you speak with?");
    if (!f.summary.trim()) return setMsg("Say what was discussed.");
    const at = new Date(f.at);
    if (Number.isNaN(at.getTime())) return setMsg("When was the call?");
    if (at.getTime() > Date.now() + 5 * 60_000) return setMsg("The call is in the future.");
    const minutes = f.minutes === "" ? undefined : Number(f.minutes);
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 240)) {
      return setMsg("Minutes: a whole number from 1 to 240.");
    }
    if (f.countFor && minutes === undefined) {
      return setMsg("Say how long the call took to count it toward PCM/CCM time, or count it toward nothing.");
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/patients/${patientId}/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurredAt: at.toISOString(),
          direction: f.direction,
          spokeWith: f.spokeWith,
          ...(minutes !== undefined && { minutes }),
          ...(score(f.pain) !== undefined && { painScore: score(f.pain) }),
          ...(score(f.dyspnea) !== undefined && { dyspneaScore: score(f.dyspnea) }),
          ...(score(f.nausea) !== undefined && { nauseaScore: score(f.nausea) }),
          summary: f.summary.trim(),
          ...(f.countFor && { countForEnrollmentId: f.countFor }),
        }),
      });
      const d = await r.json();
      if (!d.success) return setMsg(d.error ?? "Not saved.");
      onSaved();
    } catch {
      setMsg("Network error — not saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-md border border-slate-200 p-3" aria-label="Record a call">
      <Field id="call-at" label="When" required>
        <TextInput id="call-at" type="datetime-local" value={f.at} onChange={set("at")} />
      </Field>
      <Field id="call-dir" label="Who called" required>
        <Select id="call-dir" value={f.direction} onChange={set("direction")}>
          {CALL_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {CALL_DIRECTION_LABEL[d]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="call-with" label="Spoke with" required>
        <Select id="call-with" value={f.spokeWith} onChange={set("spokeWith")}>
          <option value="" disabled>
            Choose…
          </option>
          {SPOKE_WITH.map((s) => (
            <option key={s} value={s}>
              {SPOKE_WITH_LABEL[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="call-min" label="Minutes" optional explain="Time on the call. For an enrolled patient it can count toward the month's PCM/CCM time.">
        <TextInput id="call-min" type="number" inputMode="numeric" min={1} max={240} value={f.minutes} onChange={set("minutes")} />
      </Field>
      {inForce.length > 0 && (
        <Field
          id="call-count"
          label="Count the minutes toward"
          optional
          explain="The call's day is the day the time is counted on. A month already charged takes no more time."
        >
          <Select id="call-count" value={f.countFor} onChange={set("countFor")}>
            <option value="">Nothing</option>
            {inForce.map((e) => (
              <option key={e.id} value={e.id}>
                {CARE_PROGRAM_SHORT[e.program]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(
        [
          ["pain", "Pain"],
          ["dyspnea", "Shortness of breath"],
          ["nausea", "Nausea"],
        ] as const
      ).map(([k, label]) => (
        <Field key={k} id={`call-${k}`} label={`${label} (0–10)`} optional>
          <Select id={`call-${k}`} value={f[k]} onChange={set(k)}>
            <option value="">Not asked</option>
            {SCORES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      ))}
      <div className="md:col-span-3">
        <Field id="call-sum" label="What was discussed" required>
          <TextArea id="call-sum" rows={3} maxLength={4000} value={f.summary} onChange={set("summary")} />
        </Field>
      </div>
      {msg && (
        <p role="alert" className="md:col-span-3 text-sm text-red-700">
          {msg}
        </p>
      )}
      <div className="md:col-span-3 flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          Record the call
        </Button>
      </div>
    </form>
  );
}

function VoidCall({ patientId, callId, onCancel, onVoided }: { patientId: string; callId: string; onCancel: () => void; onVoided: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function voidIt() {
    if (!reason.trim()) return setMsg("Say why.");
    setBusy(true);
    try {
      const r = await fetch(`/api/patients/${patientId}/calls/${callId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ void: { reason: reason.trim() } }),
      });
      const d = await r.json();
      if (!d.success) return setMsg(d.error ?? "Not saved.");
      onVoided();
    } catch {
      setMsg("Network error — not saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Void call">
        <TextInput
          aria-label="Why it is voided"
          placeholder="Why, e.g. recorded on the wrong patient"
          maxLength={300}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setMsg(null);
          }}
          className="h-8 min-w-40 flex-1 text-sm"
        />
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="danger" size="sm" loading={busy} onClick={() => void voidIt()}>
          Void
        </Button>
      </div>
      {msg && (
        <p role="alert" className="text-sm text-red-700">
          {msg}
        </p>
      )}
    </div>
  );
}
