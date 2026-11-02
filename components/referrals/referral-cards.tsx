/**
 * The referral page's cards (Level-1 doc:22-27, 0111): what was taken down,
 * the pending-requirements checklist, and the clinical triage.
 *
 * The details correct in place as the chart's cards do (tri-state: a cleared
 * input clears the field) until the referral is admitted, when the chart is
 * where corrections go. The checklist and triage are for open referrals only;
 * the server refuses them on a closed one, and so do these cards.
 */
"use client";

import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PATIENT_ACUITIES, PATIENT_ACUITY_LABEL, type PatientAcuity } from "@/lib/features/patients/patient.types";
import {
  HOSPICE_ELIGIBILITY,
  TriageSchema,
  UpdateReferralSchema,
  isOpenStage,
  type HospiceEligibility,
  type ReferralRequirement,
  type ReferralView,
  type TriageView,
} from "@/lib/features/referrals/referral.types";

export const ACUITY_LABEL = PATIENT_ACUITY_LABEL;

export const ACUITY_STYLE: Record<PatientAcuity, string> = {
  critical: "bg-red-50 text-red-900 ring-red-600/30",
  high: "bg-orange-50 text-orange-900 ring-orange-600/30",
  medium: "bg-amber-50 text-amber-900 ring-amber-600/30",
  low: "bg-emerald-50 text-emerald-900 ring-emerald-600/20",
};

const HOSPICE_LABEL: Record<HospiceEligibility, string> = {
  yes: "Yes",
  no: "No",
  unsure: "Unsure",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={mono ? "font-mono tabular text-xs text-right" : "text-right"}>{value}</span>
    </div>
  );
}

function FormFooter({ saving, error, onCancel, label }: { saving: boolean; error: string | null; onCancel: () => void; label: string }) {
  return (
    <div className="md:col-span-2 space-y-2 pt-1">
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={saving}>
          {label}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

interface PayerOption {
  id: string;
  name: string;
  states: string[];
}
interface Member {
  userId: string;
  fullName: string | null;
  email: string;
}

/** Fields a correction cannot clear: they are sent as typed, and refused blank. */
const REQUIRED = new Set(["receivedOn", "firstName", "lastName"]);

export function ReferralDetailsCard({
  referral: r,
  canEdit,
  onSaved,
}: {
  referral: ReferralView;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const start = () => ({
    receivedOn: r.receivedOn,
    firstName: r.firstName,
    lastName: r.lastName,
    dateOfBirth: r.dateOfBirth ?? "",
    phone: r.phone ?? "",
    sourceName: r.sourceName ?? "",
    referringProviderName: r.referringProviderName ?? "",
    referringProviderNpi: r.referringProviderNpi ?? "",
    reason: r.reason ?? "",
    primaryDiagnosisIcd10: r.primaryDiagnosisIcd10 ?? "",
    payerId: r.payerId ?? "",
    memberId: r.memberId ?? "",
    assignedToUserId: r.assignedToUserId ?? "",
    notes: r.notes ?? "",
  });
  type Form = ReturnType<typeof start>;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(start);
  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [issue, setIssue] = useState<{ path: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The lists only once the form opens; the read view needs neither.
  useEffect(() => {
    if (!editing) return;
    let abandoned = false;
    fetch("/api/billing/payers")
      .then((x) => x.json())
      .then((d) => {
        if (!abandoned && d.success) setPayers(d.data?.payers ?? []);
      })
      .catch(() => {});
    fetch("/api/team/members?active=1")
      .then((x) => x.json())
      .then((d) => {
        if (!abandoned) setMembers(d.success ? (d.data?.rows ?? []) : null);
      })
      .catch(() => {});
    return () => {
      abandoned = true;
    };
  }, [editing]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setIssue(null);
  };
  const errorFor = (k: keyof Form) => (issue?.path === k ? issue.message : undefined);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const before = start();
    // Only what changed goes out; a cleared input clears the field.
    const body: Record<string, string | null> = {};
    for (const k of Object.keys(f) as (keyof Form)[]) {
      const v = k === "primaryDiagnosisIcd10" ? f[k].trim().toUpperCase() : f[k].trim();
      if (v === before[k].trim()) continue;
      body[k] = v === "" && !REQUIRED.has(k) ? null : v;
    }
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    const parsed = UpdateReferralSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      setIssue({ path: String(i.path[0] ?? ""), message: i.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/referrals/${r.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? "Not saved.");
        return;
      }
      setEditing(false);
      onSaved();
    } catch {
      setError("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle>Referral</CardTitle>
        {canEdit && !editing && (
          <Button
            variant="secondary"
            size="sm"
            aria-label="Edit referral"
            onClick={() => {
              setF(start());
              setIssue(null);
              setError(null);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-slate-700">
        {!editing ? (
          <>
            <Row label="Received" value={r.receivedOn} mono />
            <Row label="Name" value={`${r.firstName} ${r.lastName}`} />
            <Row label="DOB" value={r.dateOfBirth ?? "—"} mono />
            <Row label="Phone" value={r.phone ?? "—"} mono />
            <Row label="Source" value={r.sourceName ?? "—"} />
            <Row
              label="Referring provider"
              value={
                [r.referringProviderName, r.referringProviderNpi && `NPI ${r.referringProviderNpi}`]
                  .filter(Boolean)
                  .join(" · ") || "—"
              }
            />
            <Row label="Primary diagnosis" value={r.primaryDiagnosisIcd10 ?? "—"} mono />
            <Row label="Insurance plan" value={r.payerName ?? "Not known yet"} />
            <Row label="Member ID" value={r.memberId ?? "—"} mono />
            <Row label="Assigned to" value={r.assignedToName ?? "Nobody yet"} />
            {r.reason && (
              <div className="pt-2">
                <p className="text-slate-500">Reason for referral</p>
                <p className="whitespace-pre-wrap">{r.reason}</p>
              </div>
            )}
            {r.notes && (
              <div className="pt-2">
                <p className="text-slate-500">Notes</p>
                <p className="whitespace-pre-wrap">{r.notes}</p>
              </div>
            )}
            <p className="pt-2 text-xs text-slate-500">
              Taken down by {r.createdByName ?? "someone"}, {when(r.createdAt)}
            </p>
          </>
        ) : (
          <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="Edit referral">
            <Field id="re-received" label="Received" required error={errorFor("receivedOn")}>
              <TextInput
                id="re-received"
                type="date"
                value={f.receivedOn}
                max={r.practiceToday}
                onChange={set("receivedOn")}
                invalid={Boolean(errorFor("receivedOn"))}
              />
            </Field>
            <Field id="re-dob" label="Date of birth" optional error={errorFor("dateOfBirth")}>
              <TextInput id="re-dob" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} />
            </Field>
            <Field id="re-first" label="First name" required error={errorFor("firstName")}>
              <TextInput id="re-first" value={f.firstName} onChange={set("firstName")} invalid={Boolean(errorFor("firstName"))} />
            </Field>
            <Field id="re-last" label="Last name" required error={errorFor("lastName")}>
              <TextInput id="re-last" value={f.lastName} onChange={set("lastName")} invalid={Boolean(errorFor("lastName"))} />
            </Field>
            <Field id="re-phone" label="Phone" optional error={errorFor("phone")}>
              <TextInput id="re-phone" type="tel" value={f.phone} onChange={set("phone")} invalid={Boolean(errorFor("phone"))} />
            </Field>
            <Field id="re-source" label="Source" optional error={errorFor("sourceName")}>
              <TextInput id="re-source" value={f.sourceName} onChange={set("sourceName")} />
            </Field>
            <Field id="re-provider" label="Referring provider" optional error={errorFor("referringProviderName")}>
              <TextInput id="re-provider" value={f.referringProviderName} onChange={set("referringProviderName")} />
            </Field>
            <Field id="re-npi" label="Referring provider NPI" optional error={errorFor("referringProviderNpi")}>
              <TextInput
                id="re-npi"
                value={f.referringProviderNpi}
                onChange={set("referringProviderNpi")}
                className="tabular"
                invalid={Boolean(errorFor("referringProviderNpi"))}
              />
            </Field>
            <Field id="re-icd" label="Primary diagnosis (ICD-10)" optional error={errorFor("primaryDiagnosisIcd10")}>
              <TextInput
                id="re-icd"
                value={f.primaryDiagnosisIcd10}
                onChange={set("primaryDiagnosisIcd10")}
                className="font-mono text-sm uppercase"
                invalid={Boolean(errorFor("primaryDiagnosisIcd10"))}
              />
            </Field>
            <Field id="re-payer" label="Insurance plan" optional error={errorFor("payerId")}>
              <Select id="re-payer" value={f.payerId} onChange={set("payerId")}>
                <option value="">Not known yet</option>
                {r.payerId && !payers.some((p) => p.id === r.payerId) && (
                  <option value={r.payerId}>{r.payerName ?? "The plan on file"}</option>
                )}
                {payers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.states.length > 0 ? ` · ${p.states.join("/")}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="re-member" label="Member ID" optional error={errorFor("memberId")}>
              <TextInput id="re-member" value={f.memberId} onChange={set("memberId")} />
            </Field>
            {members && (
              <Field id="re-assigned" label="Assigned to" optional error={errorFor("assignedToUserId")}>
                <Select id="re-assigned" value={f.assignedToUserId} onChange={set("assignedToUserId")}>
                  <option value="">Nobody yet</option>
                  {r.assignedToUserId && !members.some((m) => m.userId === r.assignedToUserId) && (
                    <option value={r.assignedToUserId}>{r.assignedToName ?? "Current assignee"}</option>
                  )}
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName ?? m.email}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="md:col-span-2">
              <Field id="re-reason" label="Reason for referral" optional error={errorFor("reason")}>
                <TextArea id="re-reason" rows={3} maxLength={2000} value={f.reason} onChange={set("reason")} />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field id="re-notes" label="Notes" optional error={errorFor("notes")}>
                <TextArea id="re-notes" rows={2} maxLength={2000} value={f.notes} onChange={set("notes")} />
              </Field>
            </div>
            <FormFooter saving={saving} error={error} onCancel={() => setEditing(false)} label="Save" />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pending requirements
// ---------------------------------------------------------------------------

export function RequirementsCard({
  referral: r,
  canEdit,
  onSaved,
}: {
  referral: ReferralView;
  canEdit: boolean;
  onSaved: (requirements: ReferralRequirement[]) => void;
}) {
  const open = isOpenStage(r.stage);
  const editable = canEdit && open;
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asInput = () => r.requirements.map((i) => ({ id: i.id, label: i.label, done: Boolean(i.doneAt) }));

  async function put(next: { id: string; label: string; done: boolean }[]): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/referrals/${r.id}/requirements`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirements: next }),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? "Not saved.");
        return false;
      }
      onSaved(d.data.requirements);
      return true;
    } catch {
      setError("Network error — not saved.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const label = draft.trim();
    // One save at a time: each sends the whole list, so a second one sent
    // before the first returns would be built on the list without it.
    if (!label || saving) return;
    if (r.requirements.some((i) => i.label.toLowerCase() === label.toLowerCase())) {
      setError("That requirement is already on the list.");
      return;
    }
    // The box empties at once for the next item; a failed save puts this one
    // back, unless the next is already being typed.
    setDraft("");
    if (!(await put([...asInput(), { id: crypto.randomUUID(), label, done: false }]))) {
      setDraft((d) => (d === "" ? label : d));
    }
  }

  const done = r.requirements.filter((i) => i.doneAt).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending requirements</CardTitle>
        <CardDescription>
          {r.requirements.length === 0
            ? "What has to be in hand before admission: orders, records, an authorization."
            : `${done} of ${r.requirements.length} done.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {r.requirements.length > 0 && (
          <ul className="space-y-1.5" aria-label="Pending requirements">
            {r.requirements.map((i) => (
              <li key={i.id} className="flex items-start gap-2">
                <input
                  id={`req-${i.id}`}
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={Boolean(i.doneAt)}
                  disabled={!editable || saving}
                  onChange={() =>
                    void put(asInput().map((x) => (x.id === i.id ? { ...x, done: !x.done } : x)))
                  }
                />
                <label htmlFor={`req-${i.id}`} className="flex-1">
                  <span className={i.doneAt ? "text-slate-500 line-through" : "text-slate-800"}>{i.label}</span>
                  {i.doneAt && <span className="block text-xs text-slate-500">Done {when(i.doneAt)}</span>}
                </label>
                {editable && (
                  <button
                    type="button"
                    className="text-xs text-slate-500 hover:text-red-700 disabled:opacity-50"
                    aria-label={`Remove ${i.label}`}
                    disabled={saving}
                    onClick={() => void put(asInput().filter((x) => x.id !== i.id))}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <form onSubmit={add} className="flex gap-2" aria-label="Add a requirement">
            <TextInput
              aria-label="New requirement"
              placeholder="e.g. Signed order"
              value={draft}
              maxLength={120}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              className="h-9 text-sm"
            />
            <Button type="submit" variant="secondary" size="sm" className="h-9" disabled={!draft.trim() || saving}>
              Add
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {!open && r.requirements.length === 0 && <p className="text-slate-500">None were listed.</p>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

function TriageEntry({ t }: { t: TriageView }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {t.preliminaryAcuity ? (
          <span
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${ACUITY_STYLE[t.preliminaryAcuity]}`}
          >
            {ACUITY_LABEL[t.preliminaryAcuity]} acuity
          </span>
        ) : (
          <span className="text-xs text-slate-500">No acuity given</span>
        )}
        {t.hospiceEligible && (
          <span className="text-xs text-slate-700">Possible hospice eligibility: {HOSPICE_LABEL[t.hospiceEligible]}</span>
        )}
      </div>
      {t.symptoms && (
        <p>
          <span className="text-slate-500">Symptoms: </span>
          <span className="whitespace-pre-wrap">{t.symptoms}</span>
        </p>
      )}
      {t.immediateNeeds && (
        <p>
          <span className="text-slate-500">Immediate needs: </span>
          <span className="whitespace-pre-wrap">{t.immediateNeeds}</span>
        </p>
      )}
      {t.hospiceBasis && (
        <p>
          <span className="text-slate-500">Hospice basis: </span>
          <span className="whitespace-pre-wrap">{t.hospiceBasis}</span>
        </p>
      )}
      <p className="text-xs text-slate-500">
        {t.triagedByName ?? "Someone"}, {when(t.triagedAt)}
      </p>
    </div>
  );
}

export function TriageCard({
  referral: r,
  canTriage,
  onSaved,
}: {
  referral: ReferralView;
  canTriage: boolean;
  onSaved: () => void;
}) {
  const EMPTY = { symptoms: "", immediateNeeds: "", preliminaryAcuity: "", hospiceEligible: "", hospiceBasis: "" };
  type Form = typeof EMPTY;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(EMPTY);
  const [issue, setIssue] = useState<{ path: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const open = isOpenStage(r.stage);
  const [latest, ...earlier] = r.triage;

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setIssue(null);
    setError(null);
  };
  const errorFor = (k: keyof Form) => (issue?.path === k ? issue.message : undefined);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = Object.fromEntries(
      Object.entries(f)
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v !== ""),
    );
    const parsed = TriageSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      if (i.path.length === 0) setError(i.message);
      else setIssue({ path: String(i.path[0]), message: i.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/referrals/${r.id}/triage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? "Not saved.");
        return;
      }
      setEditing(false);
      setF(EMPTY);
      onSaved();
    } catch {
      setError("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Triage</CardTitle>
          <CardDescription>By a nurse or another member of the clinical team.</CardDescription>
        </div>
        {canTriage && open && !editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {latest ? "Triage again" : "Record triage"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        {editing && (
          <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="Record triage">
            <div className="md:col-span-2">
              <Field id="tr-symptoms" label="Symptoms" optional error={errorFor("symptoms")}>
                <TextArea id="tr-symptoms" rows={3} maxLength={2000} value={f.symptoms} onChange={set("symptoms")} />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field id="tr-needs" label="Immediate needs" optional error={errorFor("immediateNeeds")}>
                <TextArea id="tr-needs" rows={2} maxLength={2000} value={f.immediateNeeds} onChange={set("immediateNeeds")} />
              </Field>
            </div>
            <Field id="tr-acuity" label="Preliminary acuity" optional error={errorFor("preliminaryAcuity")}>
              <Select id="tr-acuity" value={f.preliminaryAcuity} onChange={set("preliminaryAcuity")}>
                <option value="">—</option>
                {PATIENT_ACUITIES.map((a) => (
                  <option key={a} value={a}>
                    {ACUITY_LABEL[a]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="tr-hospice" label="Possible hospice eligibility" optional error={errorFor("hospiceEligible")}>
              <Select id="tr-hospice" value={f.hospiceEligible} onChange={set("hospiceEligible")}>
                <option value="">—</option>
                {HOSPICE_ELIGIBILITY.map((h) => (
                  <option key={h} value={h}>
                    {HOSPICE_LABEL[h]}
                  </option>
                ))}
              </Select>
            </Field>
            {(f.hospiceEligible === "yes" || f.hospiceEligible === "unsure" || f.hospiceBasis) && (
              <div className="md:col-span-2">
                <Field id="tr-basis" label="Hospice basis" optional error={errorFor("hospiceBasis")}>
                  <TextArea id="tr-basis" rows={2} maxLength={1000} value={f.hospiceBasis} onChange={set("hospiceBasis")} />
                </Field>
              </div>
            )}
            <FormFooter
              saving={saving}
              error={error}
              label="Save triage"
              onCancel={() => {
                setEditing(false);
                setF(EMPTY);
                setIssue(null);
                setError(null);
              }}
            />
          </form>
        )}
        {latest ? (
          <TriageEntry t={latest} />
        ) : (
          !editing && <p className="text-amber-800">Not triaged yet.</p>
        )}
        {earlier.length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer text-xs text-slate-600">Earlier triage ({earlier.length})</summary>
            <div className="mt-2 space-y-3 border-l-2 border-slate-100 pl-3">
              {earlier.map((t) => (
                <TriageEntry key={t.id} t={t} />
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
