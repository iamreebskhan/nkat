/**
 * PCM/CCM time on the chart (0117; Level-1 doc:53, :69, :101; Mark Q10
 * default): one calendar month at a time, the enrolments in force in it, the
 * time logged under each (by a practitioner or clinical staff, from a call or
 * not), how far it has come under each code set, and the month's charge, which
 * a practitioner raises once the time qualifies. The rules are the pure
 * module's; the server checks every one of them again.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCodes } from "@/lib/features/billing/code-units";
import { CARE_PROGRAM_SHORT } from "@/lib/features/care-coordination/care-coordination.types";
import {
  CHARGE_BASIS_LABEL,
  CM_ACTIVITIES,
  CM_ACTIVITY_LABEL,
  MAX_CHARGE_DIAGNOSES,
  MIN_DIAGNOSES,
  PERFORMER_KIND_LABEL,
  chargeFor,
  monthBounds,
  monthLabel,
  monthOf,
  shiftMonth,
  type CareManagementMonthView,
  type ChargeBasis,
  type SetProgress,
} from "@/lib/features/care-coordination/care-management";
import { orgDay } from "@/lib/features/org/org-date";
import { usePracticeDate } from "@/lib/features/schedule/use-practice-zone";

type Program = CareManagementMonthView["programs"][number];

export function CareManagementCard({
  patientId,
  canLog,
  canVoid,
  canRaise,
  canViewBill,
  reloadKey,
  onChanged,
}: {
  patientId: string;
  /** visits.create, as a call. */
  canLog: boolean;
  /** visits.edit */
  canVoid: boolean;
  /** visits.submit; the server also wants a practitioner's credential. */
  canRaise: boolean;
  /** billing.superbills.view: the charge links to its bill. */
  canViewBill: boolean;
  /** Bumped by the calls card: a call can count its minutes here. */
  reloadKey: number;
  /** A change here can change the calls card (a voided call's time). */
  onChanged: () => void;
}) {
  // null: the practice's current month, which the server knows.
  const [month, setMonth] = useState<string | null>(null);
  const [view, setView] = useState<CareManagementMonthView | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients/${patientId}/care-management${month ? `?month=${month}` : ""}`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (!d.success) return setFailed(true);
        setView(d.data);
        setFailed(false);
      })
      .catch(() => {
        if (!abandoned) setFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [patientId, month, version, reloadKey]);

  const reload = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  if (failed) return <p className="text-sm text-slate-500">PCM/CCM time could not be loaded.</p>;
  if (!view) return <p className="text-sm text-slate-500">Loading…</p>;
  const current = monthOf(view.today);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>PCM/CCM time</CardTitle>
          <CardDescription>
            Care management time in the month, whose it is, and the month&apos;s charge once the time qualifies.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 text-sm" role="group" aria-label="Month">
          <Button variant="secondary" size="sm" onClick={() => setMonth(shiftMonth(view.month, -1))}>
            ← {monthLabel(shiftMonth(view.month, -1)).split(" ")[0]}
          </Button>
          <span className="min-w-28 text-center font-medium tabular">{monthLabel(view.month)}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={view.month >= current}
            onClick={() => setMonth(shiftMonth(view.month, 1))}
          >
            {monthLabel(shiftMonth(view.month, 1)).split(" ")[0]} →
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {view.programs.length === 0 ? (
          <p className="text-slate-500">
            Not enrolled in PCM or CCM in {monthLabel(view.month)}.{" "}
            <Link href={`/patients/${patientId}/care-plan`} className="text-[var(--color-brand-700)] hover:underline">
              Enrolment is on the care plan →
            </Link>
          </p>
        ) : (
          view.programs.map((p) => (
            <ProgramMonth
              key={p.enrollmentId}
              patientId={patientId}
              view={view}
              p={p}
              canLog={canLog}
              canVoid={canVoid}
              canRaise={canRaise}
              canViewBill={canViewBill}
              onChanged={reload}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SetLine({ label, s }: { label: string; s: SetProgress }) {
  const units = s.reached.length - 1;
  let tail: string;
  if (units < 0) {
    tail = `${s.base} needs ${s.first} min: ${s.first - s.minutes} more.`;
  } else {
    const next = s.addOn && (s.cap === null || units < s.cap) ? s.first + (units + 1) * s.each : null;
    tail = [
      `${s.base} reached ${s.reached[0]}`,
      units > 0 && `${s.addOn} ×${units} reached ${s.reached.at(-1)}`,
      next !== null && `the next ${s.addOn} at ${next} min`,
      s.addOn && s.cap !== null && units >= s.cap && `${s.addOn} is at its limit of ${s.cap}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-slate-700">{label}</span>
      <span className={`text-xs ${units >= 0 ? "font-medium text-emerald-800" : "text-slate-600"}`}>
        {s.minutes} min · {tail}
      </span>
    </li>
  );
}

function ProgramMonth({
  patientId,
  view,
  p,
  canLog,
  canVoid,
  canRaise,
  canViewBill,
  onChanged,
}: {
  patientId: string;
  view: CareManagementMonthView;
  p: Program;
  canLog: boolean;
  canVoid: boolean;
  canRaise: boolean;
  canViewBill: boolean;
  onChanged: () => void;
}) {
  const [logging, setLogging] = useState(false);
  const [raising, setRaising] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The day a charge was raised, on the practice's calendar.
  const atPracticeDay = usePracticeDate();
  const program = CARE_PROGRAM_SHORT[p.program];
  const qualifies = p.staff.reached.length > 0 || (p.qhp?.reached.length ?? 0) > 0;
  const { first, last } = monthBounds(view.month);
  // Days the form may log on: in the month, the enrolment in force, not after today.
  const earliest = [first, p.enrolledOn].sort().at(-1)!;
  const latest = [last, view.today, ...(p.endedOn ? [p.endedOn] : [])].sort()[0]!;
  const loggable = earliest <= latest;

  return (
    <section className="space-y-3 rounded-md border border-slate-200 p-3" aria-label={`${program} in ${monthLabel(view.month)}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p>
          <strong>{program}</strong>
          <span className="text-slate-500">
            {" "}
            · enrolled {p.enrolledOn} after {p.consentMethod} consent on {p.consentOn}
            {p.endedOn && ` · ended ${p.endedOn}`}
          </span>
        </p>
        <p className="text-xs text-slate-600">
          {p.minutes.staff + p.minutes.qhp} min counted: {p.minutes.staff} clinical staff, {p.minutes.qhp} practitioner
        </p>
      </div>

      <ul className="space-y-1" aria-label="Where the time stands">
        <SetLine label="Clinical staff codes (everyone's time counts)" s={p.staff} />
        {p.qhp && <SetLine label="Your own time, as the practitioner" s={p.qhp} />}
      </ul>

      {p.charge ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-emerald-900">
          <p>
            Charged {formatCodes(p.charge.codes, p.charge.units)} on{" "}
            {p.charge.basis === "staff" ? "clinical staff time" : "the practitioner's own time"}, date of service{" "}
            {orgDay(p.charge.dateOfService)}. Raised by {p.charge.raisedByName ?? "a former team member"} on{" "}
            {atPracticeDay(p.charge.raisedAt)}. The month takes no more time.
          </p>
          <p className="mt-1 text-xs">
            {canViewBill && p.charge.superbillId ? (
              <Link href={`/visits/${p.charge.visitId}/superbill`} className="underline">
                Open the bill ({(p.charge.superbillStatus ?? "draft").replace(/_/g, " ")}) →
              </Link>
            ) : (
              <Link href={`/visits/${p.charge.visitId}/view`} className="underline">
                Open the signed record →
              </Link>
            )}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {canLog && view.viewer.kind !== null && loggable && !logging && (
            <Button variant="secondary" size="sm" onClick={() => setLogging(true)}>
              Log time
            </Button>
          )}
          {canRaise && view.viewer.kind === "qhp" && qualifies && !raising && (
            <Button size="sm" onClick={() => setRaising(true)}>
              Raise {monthLabel(view.month).split(" ")[0]}&apos;s charge
            </Button>
          )}
          {canLog && view.viewer.kind === null && (
            <p className="text-xs text-slate-500">
              Your credential isn&apos;t recorded on the Team page, so time you spend is not counted. An admin adds it.
            </p>
          )}
          {qualifies && view.viewer.kind === "clinical_staff" && (
            <p className="text-xs text-slate-600">The time qualifies. A practitioner (NP, MD, DO, PA or CNS) raises the charge.</p>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
          {notice}
        </p>
      )}

      {logging && (
        <LogTimeForm
          patientId={patientId}
          enrollmentId={p.enrollmentId}
          earliest={earliest}
          latest={latest}
          onCancel={() => setLogging(false)}
          onSaved={() => {
            setLogging(false);
            onChanged();
          }}
        />
      )}
      {raising && (
        <RaiseChargeForm
          patientId={patientId}
          view={view}
          p={p}
          onCancel={() => setRaising(false)}
          onRaised={(problem) => {
            setRaising(false);
            setNotice(problem);
            onChanged();
          }}
        />
      )}

      {p.entries.length === 0 ? (
        <p className="text-slate-500">No time logged in {monthLabel(view.month)}.</p>
      ) : (
        <ul className="divide-y divide-slate-100" aria-label={`${program} time`}>
          {p.entries.map((t) => (
            <li key={t.id} className={`py-1.5 ${t.voidedAt ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className={t.voidedAt ? "line-through" : ""}>
                  <strong className="tabular">{t.serviceOn}</strong>
                  <span className="text-slate-600">
                    {" "}
                    · {t.minutes} min · {t.performedByName ?? "a former team member"} ({PERFORMER_KIND_LABEL[t.kind].toLowerCase()}) ·{" "}
                    {t.phoneEncounterId ? "from a call" : CM_ACTIVITY_LABEL[t.activity].toLowerCase()}
                  </span>
                </p>
                {canVoid && !t.voidedAt && !p.charge && voidingId !== t.id && (
                  <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => setVoidingId(t.id)}>
                    Void
                  </button>
                )}
              </div>
              {t.note && <p className="whitespace-pre-wrap text-slate-700">{t.note}</p>}
              {t.voidedAt && <p className="text-xs text-slate-500">voided: {t.voidReason}</p>}
              {!t.voidedAt && !t.counted && (
                <p className="text-xs text-amber-800">Not counted: the day is outside the enrolment.</p>
              )}
              {voidingId === t.id && (
                <VoidTime
                  patientId={patientId}
                  entryId={t.id}
                  onCancel={() => setVoidingId(null)}
                  onVoided={() => {
                    setVoidingId(null);
                    onChanged();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LogTimeForm({
  patientId,
  enrollmentId,
  earliest,
  latest,
  onSaved,
  onCancel,
}: {
  patientId: string;
  enrollmentId: string;
  earliest: string;
  latest: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({ day: latest, minutes: "", activity: "care_coordination", note: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!f.day || f.day < earliest || f.day > latest) return setMsg(`Pick a day from ${earliest} to ${latest}.`);
    const minutes = Number(f.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) return setMsg("Minutes: a whole number from 1 to 240.");
    setBusy(true);
    try {
      const r = await fetch(`/api/patients/${patientId}/care-management`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollmentId,
          serviceOn: f.day,
          minutes,
          activity: f.activity,
          ...(f.note.trim() && { note: f.note.trim() }),
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
    <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-md border border-slate-200 p-3" aria-label="Log time">
      <Field id="cm-day" label="Day" required>
        <TextInput id="cm-day" type="date" min={earliest} max={latest} value={f.day} onChange={set("day")} />
      </Field>
      <Field id="cm-min" label="Minutes" required>
        <TextInput id="cm-min" type="number" inputMode="numeric" min={1} max={240} value={f.minutes} onChange={set("minutes")} />
      </Field>
      <Field id="cm-act" label="What was done" required>
        <Select id="cm-act" value={f.activity} onChange={set("activity")}>
          {CM_ACTIVITIES.filter((a) => a !== "phone").map((a) => (
            <option key={a} value={a}>
              {CM_ACTIVITY_LABEL[a]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="md:col-span-3">
        <Field id="cm-note" label="Note" optional explain="A call's minutes are counted from the call itself: record the call instead.">
          <TextArea id="cm-note" rows={2} maxLength={500} value={f.note} onChange={set("note")} />
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
          Log the time
        </Button>
      </div>
    </form>
  );
}

function RaiseChargeForm({
  patientId,
  view,
  p,
  onRaised,
  onCancel,
}: {
  patientId: string;
  view: CareManagementMonthView;
  p: Program;
  /** With the reason when the bill could not be drafted. */
  onRaised: (problem: string | null) => void;
  onCancel: () => void;
}) {
  const sets: Record<ChargeBasis, SetProgress | null> = { staff: p.staff, qhp: p.qhp };
  const reached = (b: ChargeBasis) => (sets[b]?.reached.length ?? 0) > 0;
  const [basis, setBasis] = useState<ChargeBasis>(() => (reached("staff") ? "staff" : "qhp"));
  const chosen = sets[basis]!;
  const most = Math.max(0, chosen.reached.length - 1);
  const [units, setUnits] = useState<number | null>(null);
  const addOnUnits = units === null ? most : Math.min(units, most);
  const [pos, setPos] = useState("");
  const [dx, setDx] = useState<string[]>(() => view.problems.slice(0, MAX_CHARGE_DIAGNOSES).map((x) => x.icd10));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const preview = chargeFor(chosen, addOnUnits);
  const need = MIN_DIAGNOSES[p.program];

  async function raise(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!preview) return setMsg("The time doesn't reach this code set's minimum.");
    if (!pos) return setMsg("Where is the month billed from?");
    if (dx.length < need) {
      return setMsg(p.program === "ccm" ? "CCM is billed for two or more chronic conditions: pick at least two." : "Pick the condition PCM manages.");
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/patients/${patientId}/care-management/charges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollmentId: p.enrollmentId,
          month: view.month,
          basis,
          addOnUnits,
          placeOfService: pos,
          diagnoses: view.problems.map((x) => x.icd10).filter((c) => dx.includes(c)),
        }),
      });
      const d = await r.json();
      if (!d.success) return setMsg(d.error ?? "Not raised.");
      onRaised(
        d.data.autoDraftError
          ? `The charge is raised, but its draft bill could not be prepared: ${d.data.autoDraftError} Billing can create it from the visit.`
          : null,
      );
    } catch {
      setMsg("Network error — not raised.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={raise} noValidate className="space-y-3 rounded-md border border-slate-200 p-3" aria-label="Raise the month's charge">
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-slate-700">Bill on</legend>
        {(["staff", "qhp"] as const).map((b) => (
          <label key={b} className={`flex items-center gap-2 ${reached(b) ? "" : "text-slate-400"}`}>
            <input
              type="radio"
              name="cm-basis"
              value={b}
              checked={basis === b}
              disabled={!reached(b)}
              onChange={() => {
                setBasis(b);
                setUnits(null);
                setMsg(null);
              }}
            />
            {CHARGE_BASIS_LABEL[b]}
            {sets[b] && ` — ${sets[b]!.minutes} min${reached(b) ? "" : `, ${sets[b]!.base} needs ${sets[b]!.first}`}`}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {chosen.addOn && most > 0 && (
          <Field id="cm-units" label={`${chosen.addOn} units`} required explain="Fewer than the time allows may be billed, never more.">
            <Select id="cm-units" value={String(addOnUnits)} onChange={(e) => setUnits(Number(e.target.value))}>
              {Array.from({ length: most + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          id="cm-pos"
          label="Place of service"
          required
          explain="Where the billing practitioner ordinarily sees patients face to face. Confirm with billing which one the practice uses for care management."
        >
          <Select id="cm-pos" value={pos} onChange={(e) => {
            setPos(e.target.value);
            setMsg(null);
          }}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="11">11 — Office</option>
            <option value="12">12 — Home</option>
          </Select>
        </Field>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-slate-700">
          Diagnoses <span className="font-normal text-slate-500">({p.program === "ccm" ? "two or more chronic conditions" : "the condition managed"}, from the problem list)</span>
        </legend>
        {view.problems.length === 0 ? (
          <p className="text-slate-500">The problem list is empty. Add the condition on the chart&apos;s Overview first.</p>
        ) : (
          view.problems.map((x) => (
            <label key={x.icd10} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={dx.includes(x.icd10)}
                disabled={!dx.includes(x.icd10) && dx.length >= MAX_CHARGE_DIAGNOSES}
                onChange={(e) => {
                  setDx((cur) => (e.target.checked ? [...cur, x.icd10] : cur.filter((c) => c !== x.icd10)));
                  setMsg(null);
                }}
              />
              <span className="font-mono">{x.icd10}</span> {x.description}
            </label>
          ))
        )}
      </fieldset>
      {!view.hasCarePlan && (
        <p className="text-sm text-amber-800">
          The patient has no care plan. PCM/CCM is billed against one:{" "}
          <Link href={`/patients/${patientId}/care-plan`} className="underline">
            write it first →
          </Link>
        </p>
      )}
      {preview && (
        <p className="text-sm text-slate-700" aria-label="What the charge carries">
          Bills <strong>{formatCodes(preview.codes, preview.units)}</strong>, date of service {preview.dateOfService} (the day the
          billed time was reached), as a signed record under your name. The month then takes no more time.
        </p>
      )}
      {msg && (
        <p role="alert" className="text-sm text-red-700">
          {msg}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={busy} disabled={!view.hasCarePlan || view.problems.length === 0}>
          Raise the charge
        </Button>
      </div>
    </form>
  );
}

function VoidTime({ patientId, entryId, onCancel, onVoided }: { patientId: string; entryId: string; onCancel: () => void; onVoided: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function voidIt() {
    if (!reason.trim()) return setMsg("Say why.");
    setBusy(true);
    try {
      const r = await fetch(`/api/patients/${patientId}/care-management/time/${entryId}`, {
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
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Void time">
        <TextInput
          aria-label="Why it is voided"
          placeholder="Why, e.g. logged on the wrong patient"
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
