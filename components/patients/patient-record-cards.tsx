/**
 * The chart's Identity, Insurance, Clinical and Consents cards, with their
 * edit forms.
 *
 * Mark's intake row (Level-1 doc:21-23) is demographics and insurance, and on
 * 3 Sep he said intake "gets all the demographics in". Pallio took them at
 * intake and then showed them read-only: a wrong member ID or phone could not
 * be corrected anywhere before billing, and the referral reason intake stored
 * was shown nowhere (audit 27 Oct). Each card now edits in place. A cleared
 * input is sent as null, which clears the field (UpdatePatientSchema is
 * tri-state), and every form checks itself against that same schema before it
 * sends, so the message lands under the field rather than as a path.
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { EthnicityField, LanguageField, RacePicker } from "@/components/patients/demographic-fields";
import { CoverageCheckForm, CoverageCheckList } from "@/components/referrals/coverage-checks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { coverageGap } from "@/lib/features/patients/coverage-gap";
import { checkCoveragePair } from "@/lib/features/patients/insurance-pure";
import { UpdatePatientSchema, type PatientView, type UpdatePatient } from "@/lib/features/patients/patient.types";
import { ethnicityText, languageText, raceText } from "@/lib/features/patients/uscdi";
import type { VerificationView } from "@/lib/features/referrals/referral.types";

interface PayerOption {
  id: string;
  name: string;
  states: string[];
  ruleStates?: string[];
}

interface Issue {
  /** e.g. "demographics.zip" — the field the message belongs under. */
  path: string;
  message: string;
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={mono ? "font-mono tabular text-xs" : "text-right"}>{value}</span>
    </div>
  );
}

/** '' → null, so a cleared input clears the field. */
const orNull = (s: string) => (s.trim() === "" ? null : s.trim());

/** The first thing the API would refuse in this body, or null. */
function firstIssue(body: UpdatePatient): Issue | null {
  const r = UpdatePatientSchema.safeParse(body);
  if (r.success) return null;
  const i = r.error.issues[0];
  return i ? { path: i.path.join("."), message: i.message } : null;
}

async function patch(patientId: string, body: UpdatePatient): Promise<string | null> {
  try {
    const r = await fetch(`/api/patients/${patientId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    return d.success ? null : (d.error ?? "Not saved.");
  } catch {
    return "Network error — not saved.";
  }
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="secondary" size="sm" onClick={onClick} aria-label={`Edit ${label}`}>
      Edit
    </Button>
  );
}

function FormFooter({
  saving,
  error,
  onCancel,
}: {
  saving: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  return (
    <div className="col-span-full space-y-2 pt-1">
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
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function IdentityCard({
  patient,
  canEdit,
  onSaved,
}: {
  patient: PatientView;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const start = () => ({
    firstName: patient.firstName,
    lastName: patient.lastName,
    dateOfBirth: patient.dateOfBirth,
    sexAssignedAtBirth: patient.sexAssignedAtBirth ?? "",
    addressLine1: patient.addressLine1 ?? "",
    addressLine2: patient.addressLine2 ?? "",
    city: patient.city ?? "",
    state: patient.state ?? "",
    zip: patient.zip ?? "",
    phone: patient.phone ?? "",
    raceCodes: patient.raceCodes,
    ethnicity: patient.ethnicity ?? "",
    preferredLanguage: patient.preferredLanguage ?? "",
  });
  type Form = ReturnType<typeof start>;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setIssue(null);
  };
  const errorFor = (k: keyof Form) => (issue?.path === `demographics.${k}` ? issue.message : undefined);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: UpdatePatient = {
      demographics: {
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        dateOfBirth: f.dateOfBirth,
        sexAssignedAtBirth: (orNull(f.sexAssignedAtBirth) as PatientView["sexAssignedAtBirth"]) ?? null,
        addressLine1: orNull(f.addressLine1),
        addressLine2: orNull(f.addressLine2),
        city: orNull(f.city),
        state: orNull(f.state.toUpperCase()),
        zip: orNull(f.zip),
        phone: orNull(f.phone),
        raceCodes: f.raceCodes,
        ethnicity: orNull(f.ethnicity),
        preferredLanguage: orNull(f.preferredLanguage),
      },
    };
    const bad = firstIssue(body);
    setIssue(bad);
    if (bad) return;
    setSaving(true);
    setError(null);
    const err = await patch(patient.id, body);
    setSaving(false);
    if (err) {
      setError(err);
      return;
    }
    setEditing(false);
    onSaved();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle>Identity</CardTitle>
        {canEdit && !editing && (
          <EditButton
            label="identity"
            onClick={() => {
              setF(start());
              setIssue(null);
              setError(null);
              setEditing(true);
            }}
          />
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-slate-700">
        {!editing ? (
          <>
            <Row label="Name" value={`${patient.firstName} ${patient.lastName}`} />
            <Row label="DOB" value={patient.dateOfBirth} mono />
            <Row label="Sex assigned at birth" value={patient.sexAssignedAtBirth ?? "—"} />
            <Row label="Race" value={raceText(patient.raceCodes) ?? "—"} />
            <Row label="Ethnicity" value={ethnicityText(patient.ethnicity) ?? "—"} />
            <Row label="Preferred language" value={languageText(patient.preferredLanguage) ?? "—"} />
            <Row label="Phone" value={patient.phone ?? "—"} mono />
            <Row
              label="Address"
              value={[patient.addressLine1, patient.addressLine2].filter(Boolean).join(", ") || "—"}
            />
            <Row
              label="City / State / ZIP"
              value={`${patient.city ?? "—"}, ${patient.state ?? "—"} ${patient.zip ?? ""}`}
            />
          </>
        ) : (
          <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="Edit identity">
            <Field id="id-first" label="First name" required error={errorFor("firstName")}>
              <TextInput id="id-first" value={f.firstName} onChange={set("firstName")} invalid={Boolean(errorFor("firstName"))} />
            </Field>
            <Field id="id-last" label="Last name" required error={errorFor("lastName")}>
              <TextInput id="id-last" value={f.lastName} onChange={set("lastName")} invalid={Boolean(errorFor("lastName"))} />
            </Field>
            <Field id="id-dob" label="Date of birth" required error={errorFor("dateOfBirth")}>
              <TextInput
                id="id-dob"
                type="date"
                value={f.dateOfBirth}
                onChange={set("dateOfBirth")}
                invalid={Boolean(errorFor("dateOfBirth"))}
              />
            </Field>
            <Field id="id-sex" label="Sex assigned at birth" optional>
              <Select id="id-sex" value={f.sexAssignedAtBirth} onChange={set("sexAssignedAtBirth")}>
                <option value="">—</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
                <option value="X">X / non-binary</option>
                <option value="unknown">Unknown</option>
              </Select>
            </Field>
            <Field id="id-phone" label="Phone" optional error={errorFor("phone")}>
              <TextInput id="id-phone" type="tel" value={f.phone} onChange={set("phone")} invalid={Boolean(errorFor("phone"))} />
            </Field>
            <div className="md:col-span-2">
              <RacePicker value={f.raceCodes} onChange={(raceCodes) => setF((x) => ({ ...x, raceCodes }))} idPrefix="id-race" />
            </div>
            <EthnicityField id="id-ethnicity" value={f.ethnicity} onChange={set("ethnicity")} />
            <LanguageField id="id-language" value={f.preferredLanguage} onChange={set("preferredLanguage")} />
            <Field id="id-addr1" label="Address" optional error={errorFor("addressLine1")}>
              <TextInput id="id-addr1" value={f.addressLine1} onChange={set("addressLine1")} />
            </Field>
            <Field id="id-addr2" label="Address line 2" optional error={errorFor("addressLine2")}>
              <TextInput id="id-addr2" value={f.addressLine2} onChange={set("addressLine2")} />
            </Field>
            <Field id="id-city" label="City" optional error={errorFor("city")}>
              <TextInput id="id-city" value={f.city} onChange={set("city")} />
            </Field>
            <Field
              id="id-state"
              label="State"
              optional
              explain="Two-letter USPS abbreviation — Ohio is OH."
              error={errorFor("state")}
            >
              <TextInput
                id="id-state"
                value={f.state}
                maxLength={2}
                onChange={set("state")}
                className="uppercase tabular w-24"
                invalid={Boolean(errorFor("state"))}
              />
            </Field>
            <Field id="id-zip" label="ZIP" optional error={errorFor("zip")}>
              <TextInput id="id-zip" value={f.zip} onChange={set("zip")} className="tabular w-32" invalid={Boolean(errorFor("zip"))} />
            </Field>
            <FormFooter saving={saving} error={error} onCancel={() => setEditing(false)} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Insurance
// ---------------------------------------------------------------------------

export function InsuranceCard({
  patient,
  canEdit,
  onSaved,
}: {
  patient: PatientView;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const start = () => ({
    primaryPayerId: patient.primaryPayerId ?? "",
    insuranceState: patient.insuranceState ?? "",
    primaryMemberId: patient.primaryMemberId ?? "",
    primaryGroupNumber: patient.primaryGroupNumber ?? "",
    insuranceEffectiveDate: patient.insuranceEffectiveDate ?? "",
    insuranceTerminationDate: patient.insuranceTerminationDate ?? "",
    secondaryPayerId: patient.secondaryPayerId ?? "",
    secondaryMemberId: patient.secondaryMemberId ?? "",
    secondaryGroupNumber: patient.secondaryGroupNumber ?? "",
  });
  type Form = ReturnType<typeof start>;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [orgPayerIds, setOrgPayerIds] = useState<string[]>([]);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setIssue(null);
  };
  const errorFor = (k: keyof Form) => (issue?.path === `insurance.${k}` ? issue.message : undefined);

  // The roster only once the form opens; the read view needs none of it.
  useEffect(() => {
    if (!editing || payers.length > 0) return;
    let abandoned = false;
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (abandoned || !d.success) return;
        const list = d.data?.payers ?? d.data?.rows ?? [];
        setPayers(Array.isArray(list) ? list : []);
        setOrgPayerIds(Array.isArray(d.data?.orgPayerIds) ? d.data.orgPayerIds : []);
      })
      .catch(() => {
        /* the selects then offer the plans already on file only */
      });
    return () => {
      abandoned = true;
    };
  }, [editing, payers.length]);

  const primary = payers.find((p) => p.id === f.primaryPayerId);
  // The state rule lookups use: the policy state, or the address state while
  // none is stored — the fallback updatePatient checks the pair against.
  const effectiveState = f.insuranceState || patient.state || "";
  const gap = coverageGap(primary, effectiveState);

  function pickPrimary(id: string) {
    // Keep the state only if the new payer covers it (audit R37); a payer that
    // serves a single state fills it in. As at intake.
    const p = payers.find((x) => x.id === id);
    setF((x) => {
      const keep = !p || p.states.length === 0 || (x.insuranceState !== "" && p.states.includes(x.insuranceState));
      return {
        ...x,
        primaryPayerId: id,
        insuranceState: keep ? x.insuranceState : p.states.length === 1 ? (p.states[0] ?? "") : "",
      };
    });
    setIssue(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (f.primaryPayerId && primary) {
      const refused = checkCoveragePair({ name: primary.name, statesServed: primary.states }, effectiveState);
      if (refused) return setIssue({ path: "insurance.insuranceState", message: refused });
    }
    if (f.secondaryPayerId && f.secondaryPayerId === f.primaryPayerId) {
      return setIssue({
        path: "insurance.secondaryPayerId",
        message: "That is the primary plan. Pick a different plan, or none.",
      });
    }
    if (
      f.insuranceEffectiveDate &&
      f.insuranceTerminationDate &&
      f.insuranceTerminationDate < f.insuranceEffectiveDate
    ) {
      return setIssue({ path: "insurance.insuranceTerminationDate", message: "Ends before it starts." });
    }
    const noSecondary = f.secondaryPayerId === "";
    const body: UpdatePatient = {
      insurance: {
        // The primary plan can be changed, not removed (UpdatePatientSchema).
        ...(f.primaryPayerId && { primaryPayerId: f.primaryPayerId }),
        ...(f.insuranceState && { insuranceState: f.insuranceState.toUpperCase() }),
        primaryMemberId: orNull(f.primaryMemberId),
        primaryGroupNumber: orNull(f.primaryGroupNumber),
        insuranceEffectiveDate: orNull(f.insuranceEffectiveDate),
        insuranceTerminationDate: orNull(f.insuranceTerminationDate),
        // No secondary plan clears its member ID and group with it.
        secondaryPayerId: orNull(f.secondaryPayerId),
        secondaryMemberId: noSecondary ? null : orNull(f.secondaryMemberId),
        secondaryGroupNumber: noSecondary ? null : orNull(f.secondaryGroupNumber),
      },
    };
    const bad = firstIssue(body);
    setIssue(bad);
    if (bad) return;
    setSaving(true);
    setError(null);
    const err = await patch(patient.id, body);
    setSaving(false);
    if (err) {
      setError(err);
      return;
    }
    setEditing(false);
    onSaved();
  }

  /** The payer list, the practice's own first, as intake offers it. */
  const payerOptions = (current: string, currentName: string | null | undefined) => {
    const option = (p: PayerOption) => (
      <option key={p.id} value={p.id}>
        {p.name}
        {p.states.length > 0 ? ` · ${p.states.join("/")}` : ""}
      </option>
    );
    const ours = payers.filter((p) => orgPayerIds.includes(p.id));
    return (
      <>
        {/* A plan withdrawn from the roster still covers the patient on it,
            and the roster has not loaded on the form's first paint. */}
        {current && !payers.some((p) => p.id === current) && (
          <option value={current}>{currentName ?? "Current plan"}</option>
        )}
        {ours.length === 0 ? (
          payers.map(option)
        ) : (
          <>
            <optgroup label="Your practice's payers">{ours.map(option)}</optgroup>
            <optgroup label="Other payers">{payers.filter((p) => !orgPayerIds.includes(p.id)).map(option)}</optgroup>
          </>
        )}
      </>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle>Insurance</CardTitle>
        {canEdit && !editing && (
          <EditButton
            label="insurance"
            onClick={() => {
              setF(start());
              setIssue(null);
              setError(null);
              setEditing(true);
            }}
          />
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-slate-700">
        {!editing ? (
          <>
            <Row
              label="Insurance organization"
              value={patient.primaryPayerName ?? (patient.primaryPayerId ? "—" : "Not set")}
            />
            <Row label="Coverage state" value={patient.insuranceState ?? patient.state ?? "—"} />
            <Row label="Member ID" value={patient.primaryMemberId ?? "—"} mono />
            <Row label="Group number" value={patient.primaryGroupNumber ?? "—"} mono />
            <Row
              label="Coverage dates"
              value={
                patient.insuranceEffectiveDate && patient.insuranceTerminationDate
                  ? `${patient.insuranceEffectiveDate} to ${patient.insuranceTerminationDate}`
                  : patient.insuranceEffectiveDate
                    ? `From ${patient.insuranceEffectiveDate}, no end date`
                    : patient.insuranceTerminationDate
                      ? `Until ${patient.insuranceTerminationDate}`
                      : "—"
              }
            />
            <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
              <Row label="Secondary insurance" value={patient.secondaryPayerName ?? "None on file"} />
              {patient.secondaryPayerId && (
                <>
                  <Row label="Secondary member ID" value={patient.secondaryMemberId ?? "—"} mono />
                  <Row label="Secondary group number" value={patient.secondaryGroupNumber ?? "—"} mono />
                </>
              )}
            </div>
            {!patient.primaryPayerId && (
              <p className="mt-2 text-xs text-amber-800 bg-amber-50 ring-1 ring-inset ring-amber-600/30 rounded px-2 py-1.5">
                No payer on file — coverage rules and denial prediction are unavailable for this
                patient until one is set.
              </p>
            )}
            <PatientCoverageChecks patient={patient} canRecord={canEdit} />
          </>
        ) : (
          <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="Edit insurance">
            <Field id="ins-payer" label="Insurance organization" error={errorFor("primaryPayerId")}>
              <Select id="ins-payer" value={f.primaryPayerId} onChange={(e) => pickPrimary(e.target.value)}>
                {/* Once a plan is on file it can be changed, not blanked. */}
                {!patient.primaryPayerId && <option value="">Select…</option>}
                {payerOptions(f.primaryPayerId, patient.primaryPayerName)}
              </Select>
            </Field>
            <Field
              id="ins-state"
              label="Coverage state"
              hint={
                primary && primary.states.length > 0
                  ? `${primary.name} covers ${primary.states.join(", ")}`
                  : patient.state && !f.insuranceState
                    ? `Blank uses the address state, ${patient.state}.`
                    : "USPS 2-letter — the state the policy is issued in."
              }
              error={errorFor("insuranceState")}
            >
              {primary && primary.states.length > 0 ? (
                <Select id="ins-state" value={f.insuranceState} onChange={set("insuranceState")}>
                  {!f.insuranceState && <option value="">Select…</option>}
                  {primary.states.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              ) : (
                <TextInput
                  id="ins-state"
                  value={f.insuranceState}
                  maxLength={2}
                  onChange={set("insuranceState")}
                  className="uppercase tabular w-24"
                  invalid={Boolean(errorFor("insuranceState"))}
                />
              )}
            </Field>
            {gap?.kind === "no_rules" && (
              <p className="md:col-span-2 text-xs text-amber-800 bg-amber-50 ring-1 ring-inset ring-amber-600/30 rounded px-2 py-1.5">
                {gap.message}
              </p>
            )}
            <Field id="ins-member" label="Member ID" optional error={errorFor("primaryMemberId")}>
              <TextInput id="ins-member" value={f.primaryMemberId} onChange={set("primaryMemberId")} />
            </Field>
            <Field id="ins-group" label="Group number" optional error={errorFor("primaryGroupNumber")}>
              <TextInput id="ins-group" value={f.primaryGroupNumber} onChange={set("primaryGroupNumber")} />
            </Field>
            <Field id="ins-eff" label="Coverage starts" optional error={errorFor("insuranceEffectiveDate")}>
              <TextInput id="ins-eff" type="date" value={f.insuranceEffectiveDate} onChange={set("insuranceEffectiveDate")} />
            </Field>
            <Field id="ins-term" label="Coverage ends" optional error={errorFor("insuranceTerminationDate")}>
              <TextInput
                id="ins-term"
                type="date"
                value={f.insuranceTerminationDate}
                onChange={set("insuranceTerminationDate")}
                invalid={Boolean(errorFor("insuranceTerminationDate"))}
              />
            </Field>
            <div className="md:col-span-2 mt-1 pt-3 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field
                id="ins-sec-payer"
                label="Secondary insurance"
                optional
                explain="Carried for the claim, e.g. a Medigap or Medicaid plan behind Medicare."
                error={errorFor("secondaryPayerId")}
              >
                <Select id="ins-sec-payer" value={f.secondaryPayerId} onChange={set("secondaryPayerId")}>
                  <option value="">None</option>
                  {payerOptions(f.secondaryPayerId, patient.secondaryPayerName)}
                </Select>
              </Field>
              {f.secondaryPayerId && (
                <>
                  <Field id="ins-sec-member" label="Secondary member ID" optional error={errorFor("secondaryMemberId")}>
                    <TextInput id="ins-sec-member" value={f.secondaryMemberId} onChange={set("secondaryMemberId")} />
                  </Field>
                  <Field id="ins-sec-group" label="Secondary group number" optional error={errorFor("secondaryGroupNumber")}>
                    <TextInput id="ins-sec-group" value={f.secondaryGroupNumber} onChange={set("secondaryGroupNumber")} />
                  </Field>
                </>
              )}
            </div>
            <FormFooter saving={saving} error={error} onCancel={() => setEditing(false)} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The chart's coverage checks (Level-1 doc:23, 0111), including the ones made
 * while the patient was a referral, newest first.
 */
function PatientCoverageChecks({ patient, canRecord }: { patient: PatientView; canRecord: boolean }) {
  const [checks, setChecks] = useState<VerificationView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Bumped after a save, to read the list again.
  const [version, setVersion] = useState(0);
  // Asking the payer through the clearinghouse (0120): offered once a
  // connection can answer real-time questions.
  const [elig, setElig] = useState<{ available: boolean; vendorName: string | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!canRecord) return;
    let abandoned = false;
    fetch(`/api/patients/${patient.id}/eligibility`)
      .then((r) => r.json())
      .then((d) => {
        if (!abandoned && d.success) setElig(d.data);
      })
      .catch(() => {});
    return () => {
      abandoned = true;
    };
  }, [patient.id, canRecord]);

  async function askPayer() {
    setAsking(true);
    setAsked(null);
    try {
      const d = await fetch(`/api/patients/${patient.id}/eligibility`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((r) => r.json());
      setAsked(
        d.success
          ? { ok: true, text: `${d.data.note} (checked with ${d.data.vendorName}; saved below)` }
          : { ok: false, text: d.error ?? "Couldn't check eligibility with the payer. Try again." },
      );
      if (d.success) setVersion((v) => v + 1);
    } catch {
      setAsked({ ok: false, text: "Couldn't reach Pallio, so nothing was checked. Try again." });
    } finally {
      setAsking(false);
    }
  }

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients/${patient.id}/verifications`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (d.success) setChecks(d.data?.verifications ?? []);
        else setFailed(true);
      })
      .catch(() => {
        if (!abandoned) setFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [patient.id, version]);

  const shown = showAll ? (checks ?? []) : (checks ?? []).slice(0, 3);
  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-500">Coverage checks</span>
        <div className="flex flex-wrap gap-2">
          {canRecord && elig?.available && (
            <Button variant="secondary" size="sm" loading={asking} onClick={() => void askPayer()}>
              Check eligibility now
            </Button>
          )}
          {canRecord && !recording && (
            <Button variant="secondary" size="sm" onClick={() => setRecording(true)}>
              Record a check
            </Button>
          )}
        </div>
      </div>
      {asked && (
        <p role={asked.ok ? "status" : "alert"} className={`text-xs ${asked.ok ? "text-emerald-800" : "text-red-700"}`}>
          {asked.text}
        </p>
      )}
      {recording && (
        <CoverageCheckForm
          postUrl={`/api/patients/${patient.id}/verifications`}
          defaultPayerId={patient.primaryPayerId}
          defaultPayerName={patient.primaryPayerName ?? null}
          defaultMemberId={patient.primaryMemberId}
          onCancel={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            setVersion((v) => v + 1);
          }}
        />
      )}
      {failed ? (
        <p className="text-xs text-slate-500">The coverage checks could not be loaded.</p>
      ) : checks === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <>
          <CoverageCheckList checks={shown} emptyText="None recorded." />
          {checks.length > 3 && (
            <button
              type="button"
              className="text-xs text-[var(--color-brand-700)] hover:underline"
              onClick={() => setShowAll((s) => !s)}
            >
              {showAll ? "Show the latest 3" : `Show all ${checks.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clinical
// ---------------------------------------------------------------------------

/**
 * Diagnosis and referral reason. The acuity control stays the page's own (it
 * gates on patient.acuity.edit and saves on change), passed in as a slot.
 */
export function ClinicalCard({
  patient,
  canEdit,
  onSaved,
  acuity,
}: {
  patient: PatientView;
  canEdit: boolean;
  onSaved: () => void;
  acuity: ReactNode;
}) {
  const start = () => ({
    primaryDiagnosisIcd10: patient.primaryDiagnosisIcd10 ?? "",
    palliativeReferralReason: patient.palliativeReferralReason ?? "",
  });
  type Form = ReturnType<typeof start>;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const errorFor = (k: keyof Form) => (issue?.path === `clinical.${k}` ? issue.message : undefined);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: UpdatePatient = {
      clinical: {
        primaryDiagnosisIcd10: orNull(f.primaryDiagnosisIcd10),
        palliativeReferralReason: orNull(f.palliativeReferralReason),
      },
    };
    const bad = firstIssue(body);
    setIssue(bad);
    if (bad) return;
    setSaving(true);
    setError(null);
    const err = await patch(patient.id, body);
    setSaving(false);
    if (err) {
      setError(err);
      return;
    }
    setEditing(false);
    onSaved();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle>Clinical</CardTitle>
        {canEdit && !editing && (
          <EditButton
            label="clinical"
            onClick={() => {
              setF(start());
              setIssue(null);
              setError(null);
              setEditing(true);
            }}
          />
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-slate-700">
        {!editing ? (
          <>
            <Row label="Primary diagnosis (ICD-10)" value={patient.primaryDiagnosisIcd10 ?? "—"} mono />
            <div>
              <span className="text-slate-500">Reason for palliative referral</span>
              <p className="mt-0.5 whitespace-pre-wrap text-slate-800">
                {patient.palliativeReferralReason ?? <span className="text-slate-400">Not recorded</span>}
              </p>
            </div>
          </>
        ) : (
          <form onSubmit={save} noValidate className="grid grid-cols-1 gap-3" aria-label="Edit clinical">
            <Field id="cl-icd" label="Primary diagnosis (ICD-10)" optional error={errorFor("primaryDiagnosisIcd10")}>
              <TextInput
                id="cl-icd"
                value={f.primaryDiagnosisIcd10}
                onChange={(e) => {
                  setF((x) => ({ ...x, primaryDiagnosisIcd10: e.target.value.toUpperCase() }));
                  setIssue(null);
                }}
                className="font-mono text-sm uppercase w-40"
                placeholder="C34.90"
                invalid={Boolean(errorFor("primaryDiagnosisIcd10"))}
              />
            </Field>
            <Field
              id="cl-reason"
              label="Reason for palliative referral"
              optional
              error={errorFor("palliativeReferralReason")}
            >
              <TextArea
                id="cl-reason"
                rows={3}
                maxLength={2000}
                value={f.palliativeReferralReason}
                onChange={(e) => {
                  setF((x) => ({ ...x, palliativeReferralReason: e.target.value }));
                  setIssue(null);
                }}
              />
            </Field>
            <FormFooter saving={saving} error={error} onCancel={() => setEditing(false)} />
          </form>
        )}
        {acuity}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Consents
// ---------------------------------------------------------------------------

const CONSENTS = [
  ["hipaaAcknowledged", "hipaaAcknowledgedAt", "HIPAA notice acknowledged"],
  ["goalsOfCareConsent", "goalsOfCareConsentAt", "Goals-of-care consent"],
  ["telehealthConsent", "telehealthConsentAt", "Telehealth consent"],
] as const;
type ConsentKey = (typeof CONSENTS)[number][0];

/**
 * The consents intake records (0109; telehealth since R22), each with the
 * date it was recorded, and who signed. A consent obtained later is recorded
 * here; a withdrawn one clears its date.
 */
export function ConsentsCard({
  patient,
  canEdit,
  onSaved,
}: {
  patient: PatientView;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState<ConsentKey | "signedBy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingSigner, setEditingSigner] = useState(false);
  const [signer, setSigner] = useState("");

  async function send(consents: NonNullable<UpdatePatient["consents"]>, what: ConsentKey | "signedBy") {
    setBusy(what);
    setError(null);
    const err = await patch(patient.id, { consents });
    setBusy(null);
    if (err) {
      setError(err);
      return false;
    }
    onSaved();
    return true;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Consents</CardTitle>
        <CardDescription>Recorded at intake, or since.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-slate-700">
        {CONSENTS.map(([key, atKey, label]) => {
          const at = patient[atKey] ?? null;
          return (
            <div key={key} className="flex items-center justify-between gap-3">
              <span className="text-slate-500">{label}</span>
              <span className="flex items-center gap-3">
                <span className={at ? "tabular" : "text-amber-800"}>
                  {at ? new Date(at).toLocaleDateString() : "Not recorded"}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className="text-xs text-[var(--color-brand-700)] hover:underline disabled:opacity-50"
                    disabled={busy !== null}
                    aria-label={`${at ? "Withdraw" : "Record"} ${label}`}
                    onClick={() => {
                      if (at && !window.confirm(`Withdraw "${label}"? The date on file is cleared.`)) return;
                      void send({ [key]: !at }, key);
                    }}
                  >
                    {busy === key ? "Saving…" : at ? "Withdraw" : "Record"}
                  </button>
                )}
              </span>
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <span className="text-slate-500">Signed by</span>
          {!editingSigner ? (
            <span className="flex items-center gap-3">
              <span>{patient.consentSignedBy ?? "—"}</span>
              {canEdit && (
                <button
                  type="button"
                  className="text-xs text-[var(--color-brand-700)] hover:underline disabled:opacity-50"
                  disabled={busy !== null}
                  aria-label="Edit who signed the consents"
                  onClick={() => {
                    setSigner(patient.consentSignedBy ?? "");
                    setEditingSigner(true);
                  }}
                >
                  Edit
                </button>
              )}
            </span>
          ) : (
            <form
              className="flex items-center gap-2"
              aria-label="Edit consent signer"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await send({ signedBy: orNull(signer) }, "signedBy")) setEditingSigner(false);
              }}
            >
              <TextInput
                aria-label="Signed by"
                value={signer}
                maxLength={150}
                onChange={(e) => setSigner(e.target.value)}
                placeholder="e.g. Daughter, Ann Byers"
                className="h-8 w-56"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setEditingSigner(false)}
                disabled={busy !== null}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy === "signedBy"}>
                Save
              </Button>
            </form>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
