/**
 * The chart's Course tab (0115; Level-1 doc:37, :58, :84-95, :108): the
 * discharge and the move to hospice, acuity and its history, hospice
 * eligibility, and significant events. One read, four cards; each change
 * re-reads it.
 */
"use client";

import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ACUITY_SOURCE_LABEL,
  EVENT_KINDS,
  EVENT_KIND_LABEL,
  HOSPICE_END_REASONS,
  HOSPICE_END_REASON_LABEL,
  isHospiceCategory,
  isHospiceEvent,
  type ClinicalCourseView,
  type DischargeView,
  type EventKind,
  type PatientEventView,
} from "@/lib/features/clinical/clinical-course.types";
import { PATIENT_ACUITY_LABEL as LEVEL } from "@/lib/features/patients/patient.types";
import type { ReasonCodeView } from "@/lib/features/referrals/reason-code.service";
import { REASON_CATEGORY_LABEL, reasonCodeText } from "@/lib/features/referrals/reason-codes";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    return d.success ? null : (d.error ?? "Not saved.");
  } catch {
    return "Network error — not saved.";
  }
}

function Problem({ msg }: { msg: string | null }) {
  return msg ? (
    <p role="alert" className="text-sm text-red-700">
      {msg}
    </p>
  ) : null;
}

/** Voiding an entry recorded in error: kept, struck through, not counted. */
function VoidEventForm({
  patientId,
  eventId,
  onCancel,
  onVoided,
}: {
  patientId: string;
  eventId: string;
  onCancel: () => void;
  onVoided: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function voidIt() {
    if (!reason.trim()) return setMsg("Say why.");
    setBusy(true);
    const err = await send(`/api/patients/${patientId}/events/${eventId}`, "PATCH", { void: { reason: reason.trim() } });
    setBusy(false);
    if (err) return setMsg(err);
    onVoided();
  }

  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Void entry">
        <TextInput
          aria-label="Why it is voided"
          placeholder="Why, e.g. recorded on the wrong patient"
          maxLength={300}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setMsg(null);
          }}
          className="h-8 flex-1 min-w-40 text-sm"
        />
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="danger" size="sm" loading={busy} onClick={() => void voidIt()}>
          Void
        </Button>
      </div>
      <Problem msg={msg} />
    </div>
  );
}

export function ClinicalCourseTab({
  patientId,
  canEdit,
  canJudge,
  nextVisitDate,
  onStatusChange,
  onRecorded,
}: {
  patientId: string;
  /** patients.edit: events, the discharge, readmission. */
  canEdit: boolean;
  /** patient.acuity.edit: hospice eligibility is a clinical judgement. */
  canJudge: boolean;
  /** A visit still booked, which a discharge leaves on the schedule. */
  nextVisitDate: string | null;
  /** The chart re-reads the patient when a discharge or readmission moves its status. */
  onStatusChange: () => void;
  /** Anything recorded here: an event can raise an escalation alert (0116). */
  onRecorded?: () => void;
}) {
  const [course, setCourse] = useState<ClinicalCourseView | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients/${patientId}/clinical-course`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (d.success) {
          setCourse(d.data);
          setFailed(false);
        } else setFailed(true);
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
    onRecorded?.();
  };

  if (failed) return <p className="text-sm text-slate-500">The course of care could not be loaded.</p>;
  if (!course) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <DischargeCard
        patientId={patientId}
        course={course}
        canEdit={canEdit}
        nextVisitDate={nextVisitDate}
        onSaved={() => {
          reload();
          onStatusChange();
        }}
      />
      <AcuityCard course={course} />
      <HospiceCard patientId={patientId} course={course} canAssess={canJudge} canRecord={canEdit} onSaved={reload} />
      <EventsCard patientId={patientId} course={course} canEdit={canEdit} onSaved={reload} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discharge and the move to hospice
// ---------------------------------------------------------------------------

type Mode = null | "discharge" | "hospice" | "readmit";

function DischargeCard({
  patientId,
  course,
  canEdit,
  nextVisitDate,
  onSaved,
}: {
  patientId: string;
  course: ClinicalCourseView;
  canEdit: boolean;
  nextVisitDate: string | null;
  onSaved: () => void;
}) {
  const today = course.practiceToday;
  const current = course.discharges.find((d) => !d.reversedAt) ?? null;
  const earlier = course.discharges.filter((d) => d.reversedAt);
  const underCare = course.status === "active";
  const toHospice = current !== null && isHospiceCategory(current.category);
  const [mode, setMode] = useState<Mode>(null);
  const [codes, setCodes] = useState<ReasonCodeView[] | null>(null);
  const [f, setF] = useState({
    dischargedOn: today, reasonCodeId: "", note: "", hospiceName: "", hospiceAdmittedOn: "", diedOn: "",
    hospiceEndedOn: "", hospiceEndReason: "", readmittedOn: today, readmitReason: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
  };
  const open = (m: Mode) => {
    setMode(m);
    setMsg(null);
  };

  useEffect(() => {
    if (mode !== "discharge" || codes) return;
    let abandoned = false;
    fetch("/api/settings/reason-codes?kind=discharge")
      .then((r) => r.json())
      .then((d) => {
        if (!abandoned) setCodes(d.success ? (d.data.codes ?? []) : []);
      })
      .catch(() => {
        if (!abandoned) setCodes([]);
      });
    return () => {
      abandoned = true;
    };
  }, [mode, codes]);

  const picked = codes?.find((c) => c.id === f.reasonCodeId);
  const hospice = picked ? isHospiceCategory(picked.category) : false;
  const death = picked?.category === "death";

  async function save(url: string, method: "POST" | "PATCH", body: unknown) {
    setBusy(true);
    const err = await send(url, method, body);
    setBusy(false);
    if (err) return setMsg(err);
    setMode(null);
    onSaved();
  }

  function discharge(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!f.reasonCodeId) return setMsg("Pick the reason.");
    if (f.dischargedOn > today) return setMsg("The discharge is after today.");
    void save(`/api/patients/${patientId}/discharge`, "POST", {
      dischargedOn: f.dischargedOn,
      reasonCodeId: f.reasonCodeId,
      ...(f.note.trim() && { note: f.note.trim() }),
      ...(hospice && f.hospiceName.trim() && { hospiceName: f.hospiceName.trim() }),
      ...(hospice && f.hospiceAdmittedOn && { hospiceAdmittedOn: f.hospiceAdmittedOn }),
      ...(death && f.diedOn && { diedOn: f.diedOn }),
    });
  }

  function hospiceStay(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!current) return;
    if (Boolean(f.hospiceEndedOn) !== Boolean(f.hospiceEndReason)) {
      return setMsg("Give the day the hospice stay ended and how it ended, together.");
    }
    if (f.hospiceEndedOn && !f.hospiceAdmittedOn) return setMsg("Say when the hospice admitted the patient.");
    if (f.hospiceEndedOn && f.hospiceEndedOn < f.hospiceAdmittedOn) return setMsg("The hospice stay ended before it began.");
    // What changed, and only that.
    const ending = f.hospiceEndedOn !== (current.hospiceEndedOn ?? "") || f.hospiceEndReason !== (current.hospiceEndReason ?? "");
    const body = {
      ...(f.hospiceName.trim() !== (current.hospiceName ?? "") && { hospiceName: f.hospiceName.trim() }),
      ...(f.hospiceAdmittedOn && f.hospiceAdmittedOn !== current.hospiceAdmittedOn && { hospiceAdmittedOn: f.hospiceAdmittedOn }),
      ...(f.hospiceEndedOn && ending && { hospiceEndedOn: f.hospiceEndedOn, hospiceEndReason: f.hospiceEndReason }),
    };
    if (Object.keys(body).length === 0) return setMode(null);
    void save(`/api/patients/${patientId}/discharge`, "PATCH", body);
  }

  function readmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!f.readmitReason.trim()) return setMsg("Say why.");
    if (current && f.readmittedOn < current.dischargedOn) {
      return setMsg(`The discharge was on ${current.dischargedOn}; the readmission cannot be earlier.`);
    }
    void save(`/api/patients/${patientId}/readmit`, "POST", { readmittedOn: f.readmittedOn, reason: f.readmitReason.trim() });
  }

  const groups = new Map<string, ReasonCodeView[]>();
  for (const c of codes ?? []) {
    const g = REASON_CATEGORY_LABEL[c.category];
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }

  const stayLabel = !current?.hospiceAdmittedOn
    ? "Add the hospice admission"
    : !current.hospiceEndedOn
      ? "Record how the hospice stay ended"
      : "Correct the hospice stay";

  return (
    <Card className="md:col-span-2">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Care episode</CardTitle>
          <CardDescription>
            {underCare
              ? `Under care since ${course.admittedOn ?? "—"}.`
              : current
                ? `${course.status === "deceased" ? "Died" : "Discharged"} on ${current.diedOn ?? current.dischargedOn}.`
                : `Status: ${course.status}.`}
          </CardDescription>
        </div>
        {canEdit && mode === null && (
          <div className="flex flex-wrap justify-end gap-2">
            {underCare && (
              <Button variant="secondary" size="sm" onClick={() => open("discharge")}>
                Discharge
              </Button>
            )}
            {toHospice && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setF((x) => ({
                    ...x,
                    hospiceName: current.hospiceName ?? "",
                    hospiceAdmittedOn: current.hospiceAdmittedOn ?? "",
                    hospiceEndedOn: current.hospiceEndedOn ?? "",
                    hospiceEndReason: current.hospiceEndReason ?? "",
                  }));
                  open("hospice");
                }}
              >
                {stayLabel}
              </Button>
            )}
            {(course.status === "discharged" || course.status === "deceased") && (
              <Button variant="secondary" size="sm" onClick={() => open("readmit")}>
                Readmit
              </Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {current && <DischargeSummary d={current} />}

        {mode === "discharge" && (
          <form onSubmit={discharge} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-md border border-slate-200 p-3" aria-label="Discharge">
            <Field id="dc-day" label="Discharged on" required>
              <TextInput id="dc-day" type="date" value={f.dischargedOn} min={course.admittedOn ?? undefined} max={today} onChange={set("dischargedOn")} />
            </Field>
            <Field id="dc-reason" label="Reason" required>
              <Select id="dc-reason" value={f.reasonCodeId} onChange={set("reasonCodeId")} disabled={codes === null}>
                <option value="" disabled>
                  {codes === null ? "Loading…" : "Choose the reason…"}
                </option>
                {[...groups].map(([label, list]) => (
                  <optgroup key={label} label={label}>
                    {list.map((c) => (
                      <option key={c.id} value={c.id}>
                        {reasonCodeText(c)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            {hospice && (
              <>
                <Field id="dc-hospice" label="Hospice" optional>
                  <TextInput id="dc-hospice" maxLength={150} value={f.hospiceName} onChange={set("hospiceName")} />
                </Field>
                <Field
                  id="dc-hosp-adm"
                  label="Hospice admission"
                  optional
                  explain="The day the hospice admitted the patient. Hospice length of stay is counted from it; it can be added later."
                >
                  <TextInput id="dc-hosp-adm" type="date" max={today} value={f.hospiceAdmittedOn} onChange={set("hospiceAdmittedOn")} />
                </Field>
              </>
            )}
            {death && (
              <Field id="dc-died" label="Died on" optional explain="The discharge day when left blank.">
                <TextInput id="dc-died" type="date" max={today} value={f.diedOn} onChange={set("diedOn")} />
              </Field>
            )}
            <div className="md:col-span-2">
              <Field id="dc-note" label="Note" optional>
                <TextArea id="dc-note" rows={2} maxLength={1000} value={f.note} onChange={set("note")} />
              </Field>
            </div>
            {nextVisitDate && (
              <p className="md:col-span-2 text-xs text-amber-900 bg-amber-50 px-2 py-2 rounded">
                A visit is still booked for {nextVisitDate}. Discharging does not cancel it: cancel it on the visit if it
                will not happen.
              </p>
            )}
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => open(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                Discharge
              </Button>
            </div>
          </form>
        )}

        {mode === "hospice" && current && (
          <form onSubmit={hospiceStay} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-md border border-slate-200 p-3" aria-label="Hospice stay">
            <Field id="hs-name" label="Hospice" optional>
              <TextInput id="hs-name" maxLength={150} value={f.hospiceName} onChange={set("hospiceName")} />
            </Field>
            <Field id="hs-adm" label="Hospice admission" optional explain="The day the hospice admitted the patient.">
              <TextInput id="hs-adm" type="date" max={today} value={f.hospiceAdmittedOn} onChange={set("hospiceAdmittedOn")} />
            </Field>
            <Field id="hs-end" label="Hospice stay ended" optional explain="When the stay is over: with how it ended, it gives the hospice length of stay.">
              <TextInput id="hs-end" type="date" min={f.hospiceAdmittedOn || undefined} max={today} value={f.hospiceEndedOn} onChange={set("hospiceEndedOn")} />
            </Field>
            <Field id="hs-why" label="How it ended" optional>
              <Select id="hs-why" value={f.hospiceEndReason} onChange={set("hospiceEndReason")}>
                <option value="">Not ended yet</option>
                {HOSPICE_END_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {HOSPICE_END_REASON_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => open(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                Save
              </Button>
            </div>
          </form>
        )}

        {mode === "readmit" && (
          <form onSubmit={readmit} noValidate className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-md border border-slate-200 p-3" aria-label="Readmit">
            <Field id="ra-day" label="Readmitted on" required>
              <TextInput id="ra-day" type="date" min={current?.dischargedOn} max={today} value={f.readmittedOn} onChange={set("readmittedOn")} />
            </Field>
            <div className="md:col-span-2">
              <Field id="ra-why" label="Why" required explain="Back under care, or the discharge was recorded in error.">
                <TextInput id="ra-why" maxLength={300} value={f.readmitReason} onChange={set("readmitReason")} />
              </Field>
            </div>
            <div className="md:col-span-3 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => open(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                Readmit
              </Button>
            </div>
          </form>
        )}

        {earlier.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-600">Earlier episodes ({earlier.length})</summary>
            <ul className="mt-2 space-y-2 border-l-2 border-slate-100 pl-3">
              {earlier.map((d) => (
                <li key={d.id}>
                  <DischargeSummary d={d} />
                  <p className="text-xs text-slate-500">
                    Reversed {when(d.reversedAt!)}: {d.reversedReason}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        )}
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

function DischargeSummary({ d }: { d: DischargeView }) {
  return (
    <div className="space-y-0.5">
      <p>
        <span className="font-mono">{d.reasonCode}</span> {d.reasonLabel}
        <span className="text-slate-500"> · discharged {d.dischargedOn}</span>
        {d.lengthOfStayDays !== null && <span className="text-slate-500"> · {days(d.lengthOfStayDays)} on service</span>}
      </p>
      {(d.hospiceName || d.hospiceAdmittedOn) && (
        <p className="text-slate-700">
          Hospice{d.hospiceName ? `: ${d.hospiceName}` : ""}
          {d.hospiceAdmittedOn && ` · admitted ${d.hospiceAdmittedOn}`}
          {d.hospiceEndedOn &&
            d.hospiceEndReason &&
            ` · ${HOSPICE_END_REASON_LABEL[d.hospiceEndReason].toLowerCase()} ${d.hospiceEndedOn}` +
              (d.hospiceLengthOfStayDays !== null ? ` · ${days(d.hospiceLengthOfStayDays)} in hospice` : "")}
        </p>
      )}
      {d.diedOn && <p className="text-slate-700">Died {d.diedOn}</p>}
      {d.note && <p className="text-xs text-slate-600 whitespace-pre-wrap">{d.note}</p>}
      <p className="text-xs text-slate-500">
        {d.recordedByName ?? "Someone"}, {when(d.recordedAt)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Acuity
// ---------------------------------------------------------------------------

function AcuityCard({ course }: { course: ClinicalCourseView }) {
  const h = course.acuity.history;
  const triage = course.acuity.triage;
  const visit = h.find((e) => e.source === "visit");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Acuity</CardTitle>
        <CardDescription>The triage&rsquo;s and the NP&rsquo;s, kept apart, and every change.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="text-xs text-slate-500">Now</p>
            <p className="font-medium">{course.acuity.current ? LEVEL[course.acuity.current] : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">At triage</p>
            <p className="font-medium">
              {triage ? LEVEL[triage.acuity] : "—"}
              {triage && <span className="text-xs text-slate-500"> · {triage.on}</span>}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Last NP visit</p>
            <p className="font-medium">
              {visit ? LEVEL[visit.acuity] : "—"}
              {visit?.visitDay && <span className="text-xs text-slate-500"> · {visit.visitDay}</span>}
            </p>
          </div>
        </div>
        {h.length === 0 ? (
          <p className="text-slate-500">No acuity given yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Acuity history">
            {h.map((e) => (
              <li key={e.id} className="py-1 flex flex-wrap justify-between gap-2">
                <span>
                  {LEVEL[e.acuity]} <span className="text-slate-500">· {ACUITY_SOURCE_LABEL[e.source]}</span>
                  {e.visitDay && <span className="text-slate-500"> ({e.visitDay})</span>}
                </span>
                <span className="text-xs text-slate-500">
                  {e.recordedByName ?? "Someone"}, {when(e.recordedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">Change it on the Overview, or give it at a visit.</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Hospice: eligibility, discussions and referrals (doc:37, :91-92)
// ---------------------------------------------------------------------------

type HospiceMode = null | "assess" | "hospice_discussion" | "hospice_referral";

const HOSPICE_FORM_LABEL: Record<Exclude<HospiceMode, null>, string> = {
  assess: "Hospice eligibility assessment",
  hospice_discussion: "Hospice discussion",
  hospice_referral: "Hospice referral",
};

function HospiceCard({
  patientId,
  course,
  canAssess,
  canRecord,
  onSaved,
}: {
  patientId: string;
  course: ClinicalCourseView;
  /** patient.acuity.edit: eligibility is a clinical judgement. */
  canAssess: boolean;
  /** patients.edit: a discussion or a referral is recorded like any event. */
  canRecord: boolean;
  onSaved: () => void;
}) {
  const today = course.practiceToday;
  const START = { eligible: "", on: today, note: "", hospice: "" };
  const [mode, setMode] = useState<HospiceMode>(null);
  const [f, setF] = useState(START);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [latest, ...earlier] = course.hospice.assessments;
  const contacts = course.events.filter((e) => isHospiceEvent(e.kind));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
  };
  const open = (m: HospiceMode) => {
    setMode(m);
    setF(START);
    setMsg(null);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (mode === "assess" && !f.eligible) return setMsg("Yes or no?");
    if (f.on > today) return setMsg("That day is after today.");
    setBusy(true);
    const err =
      mode === "assess"
        ? await send(`/api/patients/${patientId}/hospice-assessments`, "POST", {
            eligible: f.eligible === "yes",
            assessedOn: f.on,
            ...(f.note.trim() && { basis: f.note.trim() }),
          })
        : await send(`/api/patients/${patientId}/events`, "POST", {
            kind: mode,
            occurredOn: f.on,
            ...(mode === "hospice_referral" && f.hospice.trim() && { facility: f.hospice.trim() }),
            ...(f.note.trim() && { description: f.note.trim() }),
          });
    setBusy(false);
    if (err) return setMsg(err);
    open(null);
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hospice</CardTitle>
        <CardDescription>Eligibility, discussions with the patient and family, and referrals.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {mode === null && (canAssess || canRecord) && (
          <div className="flex flex-wrap gap-2">
            {canAssess && (
              <Button variant="secondary" size="sm" onClick={() => open("assess")}>
                Assess eligibility
              </Button>
            )}
            {canRecord && (
              <>
                <Button variant="secondary" size="sm" onClick={() => open("hospice_discussion")}>
                  Record a discussion
                </Button>
                <Button variant="secondary" size="sm" onClick={() => open("hospice_referral")}>
                  Record a referral
                </Button>
              </>
            )}
          </div>
        )}
        {mode !== null && (
          <form onSubmit={save} noValidate className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border border-slate-200 p-3" aria-label={HOSPICE_FORM_LABEL[mode]}>
            {mode === "assess" && (
              <Field id="he-elig" label="Eligible for hospice" required>
                <Select id="he-elig" value={f.eligible} onChange={set("eligible")}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </Field>
            )}
            <Field
              id="he-day"
              label={mode === "assess" ? "Assessed on" : mode === "hospice_referral" ? "Referred on" : "Discussed on"}
              required
            >
              <TextInput id="he-day" type="date" max={today} value={f.on} onChange={set("on")} />
            </Field>
            {mode === "hospice_referral" && (
              <Field id="he-hospice" label="Hospice" optional>
                <TextInput id="he-hospice" maxLength={150} value={f.hospice} onChange={set("hospice")} />
              </Field>
            )}
            <div className="sm:col-span-2">
              <Field
                id="he-note"
                label={mode === "assess" ? "Basis" : mode === "hospice_referral" ? "Note" : "What was discussed, and with whom"}
                optional
              >
                <TextArea id="he-note" rows={2} maxLength={1000} value={f.note} onChange={set("note")} />
              </Field>
            </div>
            <div className="sm:col-span-2 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => open(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                Save
              </Button>
            </div>
          </form>
        )}
        {latest ? (
          <div>
            <p>
              <strong className={latest.eligible ? "text-amber-800" : "text-slate-800"}>
                {latest.eligible ? "Eligible" : "Not eligible"}
              </strong>
              <span className="text-slate-500"> · assessed {latest.assessedOn}</span>
            </p>
            {latest.basis && <p className="text-slate-700 whitespace-pre-wrap">{latest.basis}</p>}
            <p className="text-xs text-slate-500">{latest.assessedByName ?? "Someone"}</p>
          </div>
        ) : (
          <p className="text-slate-500">Not assessed yet.</p>
        )}
        {course.hospice.triage && (
          <p className="text-xs text-slate-600">
            At triage ({course.hospice.triage.on}): {course.hospice.triage.eligible}
            {course.hospice.triage.basis ? ` — ${course.hospice.triage.basis}` : ""}
          </p>
        )}
        {earlier.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-600">Earlier ({earlier.length})</summary>
            <ul className="mt-2 space-y-1 border-l-2 border-slate-100 pl-3">
              {earlier.map((a) => (
                <li key={a.id} className="text-slate-600">
                  {a.eligible ? "Eligible" : "Not eligible"} · {a.assessedOn}
                  {a.basis ? ` — ${a.basis}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
        {contacts.length > 0 && (
          <ul className="divide-y divide-slate-100 border-t border-slate-100" aria-label="Hospice discussions and referrals">
            {contacts.map((ev) => (
              <li key={ev.id} className={`py-2 ${ev.voidedAt ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className={ev.voidedAt ? "line-through" : ""}>
                    <strong>{EVENT_KIND_LABEL[ev.kind]}</strong>
                    <span className="text-slate-500">
                      {" "}
                      · {ev.occurredOn}
                      {ev.facility && ` · ${ev.facility}`}
                    </span>
                  </p>
                  {canRecord && !ev.voidedAt && voidingId !== ev.id && (
                    <button
                      type="button"
                      className="text-xs text-slate-500 hover:text-red-700"
                      onClick={() => setVoidingId(ev.id)}
                    >
                      Void
                    </button>
                  )}
                </div>
                {ev.description && <p className="text-slate-700 whitespace-pre-wrap">{ev.description}</p>}
                <p className="text-xs text-slate-500">
                  {ev.recordedByName ?? "Someone"}, {when(ev.recordedAt)}
                  {ev.voidedAt && ` · voided: ${ev.voidReason}`}
                </p>
                {voidingId === ev.id && (
                  <VoidEventForm
                    patientId={patientId}
                    eventId={ev.id}
                    onCancel={() => setVoidingId(null)}
                    onVoided={() => {
                      setVoidingId(null);
                      onSaved();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Significant events
// ---------------------------------------------------------------------------

function EventsCard({
  patientId,
  course,
  canEdit,
  onSaved,
}: {
  patientId: string;
  course: ClinicalCourseView;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const today = course.practiceToday;
  const START = { kind: "", occurredOn: today, endedOn: "", facility: "", injury: false, description: "" };
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(START);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [endedOn, setEndedOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: "kind" | "occurredOn" | "endedOn" | "facility" | "description") => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
  };
  const atHospital = f.kind === "ed_visit" || f.kind === "hospital_admission";

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!f.kind) return setMsg("What happened?");
    if (f.occurredOn > today) return setMsg("The event is after today.");
    if (f.kind === "hospital_admission" && f.endedOn && f.endedOn < f.occurredOn) return setMsg("Discharged before admitted.");
    setBusy(true);
    const err = await send(`/api/patients/${patientId}/events`, "POST", {
      kind: f.kind,
      occurredOn: f.occurredOn,
      ...(f.kind === "hospital_admission" && f.endedOn && { endedOn: f.endedOn }),
      ...(atHospital && f.facility.trim() && { facility: f.facility.trim() }),
      ...(f.kind === "fall" && { injury: f.injury }),
      ...(f.description.trim() && { description: f.description.trim() }),
    });
    setBusy(false);
    if (err) return setMsg(err);
    setAdding(false);
    setF(START);
    onSaved();
  }

  async function patch(ev: PatientEventView, body: unknown) {
    setBusy(true);
    setMsg(null);
    const err = await send(`/api/patients/${patientId}/events/${ev.id}`, "PATCH", body);
    setBusy(false);
    if (err) return setMsg(err);
    setEndingId(null);
    onSaved();
  }

  // Hospice discussions and referrals are shown with hospice eligibility.
  const events = course.events.filter((e) => !isHospiceEvent(e.kind));
  const live = events.filter((e) => !e.voidedAt);
  const count = (k: EventKind) => live.filter((e) => e.kind === k).length;
  const readmissions = live.filter((e) => e.readmission).length;

  return (
    <Card className="md:col-span-2">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Events</CardTitle>
          <CardDescription>
            Falls {count("fall")} · ED visits {count("ed_visit")} · Admissions {count("hospital_admission")}
            {readmissions > 0 && ` (${readmissions} ${readmissions === 1 ? "readmission" : "readmissions"})`}
          </CardDescription>
        </div>
        {canEdit && !adding && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAdding(true);
              setMsg(null);
            }}
          >
            Record event
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {adding && (
          <form onSubmit={add} noValidate className="grid grid-cols-1 md:grid-cols-3 gap-2 rounded-md border border-slate-200 p-3" aria-label="Record an event">
            <Field id="ev-kind" label="What happened" required>
              <Select id="ev-kind" value={f.kind} onChange={set("kind")}>
                <option value="" disabled>
                  Choose…
                </option>
                {EVENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {EVENT_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="ev-day" label={f.kind === "hospital_admission" ? "Admitted on" : "On"} required>
              <TextInput id="ev-day" type="date" max={today} value={f.occurredOn} onChange={set("occurredOn")} />
            </Field>
            {f.kind === "hospital_admission" ? (
              <Field id="ev-end" label="Discharged on" optional>
                <TextInput id="ev-end" type="date" min={f.occurredOn} max={today} value={f.endedOn} onChange={set("endedOn")} />
              </Field>
            ) : f.kind === "fall" ? (
              <label className="flex items-center gap-2 self-end pb-2">
                <input type="checkbox" checked={f.injury} onChange={(e) => setF((x) => ({ ...x, injury: e.target.checked }))} />
                <span>With injury</span>
              </label>
            ) : (
              <div />
            )}
            {atHospital && (
              <Field id="ev-fac" label="Hospital" optional>
                <TextInput id="ev-fac" maxLength={150} value={f.facility} onChange={set("facility")} />
              </Field>
            )}
            <div className="md:col-span-3">
              <Field id="ev-desc" label="What happened, briefly" optional>
                <TextArea id="ev-desc" rows={2} maxLength={1000} value={f.description} onChange={set("description")} />
              </Field>
            </div>
            <div className="md:col-span-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setMsg(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                Record
              </Button>
            </div>
          </form>
        )}
        {events.length === 0 ? (
          <p className="text-slate-500">No falls, ED visits or admissions recorded.</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Events">
            {events.map((ev) => (
              <li key={ev.id} className={`py-2 ${ev.voidedAt ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className={ev.voidedAt ? "line-through" : ""}>
                    <strong>{EVENT_KIND_LABEL[ev.kind]}</strong>
                    <span className="text-slate-500">
                      {" "}
                      · {ev.occurredOn}
                      {ev.kind === "hospital_admission" && (ev.endedOn ? ` to ${ev.endedOn}` : " · still admitted")}
                      {ev.facility && ` · ${ev.facility}`}
                      {ev.kind === "fall" && ev.injury !== null && (ev.injury ? " · with injury" : " · no injury")}
                    </span>
                    {ev.readmission && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 ring-1 ring-inset ring-amber-600/30">
                        readmission
                      </span>
                    )}
                  </p>
                  {canEdit && !ev.voidedAt && voidingId !== ev.id && endingId !== ev.id && (
                    <span className="flex gap-3">
                      {ev.kind === "hospital_admission" && !ev.endedOn && (
                        <button
                          type="button"
                          className="text-xs text-slate-500 hover:text-slate-900"
                          onClick={() => {
                            setEndingId(ev.id);
                            setEndedOn(today);
                            setMsg(null);
                          }}
                        >
                          Discharged
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-xs text-slate-500 hover:text-red-700"
                        onClick={() => {
                          setVoidingId(ev.id);
                          setMsg(null);
                        }}
                      >
                        Void
                      </button>
                    </span>
                  )}
                </div>
                {ev.description && <p className="text-slate-700 whitespace-pre-wrap">{ev.description}</p>}
                <p className="text-xs text-slate-500">
                  {ev.recordedByName ?? "Someone"}, {when(ev.recordedAt)}
                  {ev.voidedAt && ` · voided: ${ev.voidReason}`}
                </p>
                {endingId === ev.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="Hospital discharge day">
                    <TextInput type="date" aria-label="Discharged on" min={ev.occurredOn} max={today} value={endedOn} onChange={(e) => setEndedOn(e.target.value)} className="h-8 w-40 text-sm" />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEndingId(null)}>
                      Cancel
                    </Button>
                    <Button type="button" size="sm" loading={busy} onClick={() => void patch(ev, { endedOn })}>
                      Save
                    </Button>
                  </div>
                )}
                {voidingId === ev.id && (
                  <VoidEventForm
                    patientId={patientId}
                    eventId={ev.id}
                    onCancel={() => setVoidingId(null)}
                    onVoided={() => {
                      setVoidingId(null);
                      onSaved();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}
