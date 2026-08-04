/**
 * /patients/new — 5-step intake wizard.
 *
 * Steps per pallio_complete_vision_v3 §6.2:
 *   1. Demographics
 *   2. Insurance
 *   3. Clinical (ICD-10 + referral reason)
 *   4. Consents (HIPAA / GoC / Telehealth)
 *   5. Care team
 *
 * On finish: POST /api/patients with the full `CreatePatient`
 * payload. Redirects to /patients/[id] on success.
 */
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { InfoTip } from "@/components/ui/info-tip";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
  CreatePatientSchema,
  type CreatePatient,
} from "@/lib/features/patients/patient.types";

const EMPTY: CreatePatient = {
  demographics: {
    firstName: "",
    lastName: "",
    dateOfBirth: "",
  },
  insurance: {},
  clinical: {},
  consents: {
    hipaaAcknowledged: false,
    goalsOfCareConsent: false,
    telehealthConsent: false,
  },
  careTeam: {},
};

export default function NewPatientPage() {
  const router = useRouter();
  const [data, setData] = useState<CreatePatient>(EMPTY);

  function setDemographics<K extends keyof CreatePatient["demographics"]>(
    key: K,
    value: CreatePatient["demographics"][K],
  ) {
    setData((d) => ({ ...d, demographics: { ...d.demographics, [key]: value } }));
  }
  function setInsurance<K extends keyof CreatePatient["insurance"]>(
    key: K,
    value: CreatePatient["insurance"][K],
  ) {
    setData((d) => ({ ...d, insurance: { ...d.insurance, [key]: value } }));
  }
  function setClinical<K extends keyof CreatePatient["clinical"]>(
    key: K,
    value: CreatePatient["clinical"][K],
  ) {
    setData((d) => ({ ...d, clinical: { ...d.clinical, [key]: value } }));
  }
  function setConsents<K extends keyof CreatePatient["consents"]>(
    key: K,
    value: CreatePatient["consents"][K],
  ) {
    setData((d) => ({ ...d, consents: { ...d.consents, [key]: value } }));
  }
  function setCareTeam<K extends keyof CreatePatient["careTeam"]>(
    key: K,
    value: CreatePatient["careTeam"][K],
  ) {
    setData((d) => ({ ...d, careTeam: { ...d.careTeam, [key]: value } }));
  }

  // Payer reference list for the Insurance step. The patient's payer is what
  // every downstream coverage rule keys on, so it must be a real pick — not a
  // pasted UUID.
  const [payers, setPayers] = useState<{ id: string; name: string; states: string[] }[]>([]);
  useEffect(() => {
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return;
        const list = d.data?.payers ?? d.data?.rows ?? [];
        setPayers(Array.isArray(list) ? list : []);
      })
      .catch(() => undefined);
  }, []);

  // ACTIVE org roster for step 5 — fetched only when the user holds
  // patients.careteam.edit (mirrors the POST gate exactly; roles are
  // display-only). Gating the UI on roster-fetch success alone would let a
  // user WITH team.view but WITHOUT the permission pick assignments and then
  // hard-fail the whole intake at the final step. ?active=1 keeps the picker
  // consistent with what the service accepts.
  const [roster, setRoster] = useState<{ userId: string; fullName: string | null; email: string }[] | null>(null);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((me) => {
        const can =
          me.success &&
          ((me.data?.permissions ?? []).includes("patients.careteam.edit") ||
            me.data?.role === "platform_admin");
        if (!can) return;
        return fetch("/api/team/members?active=1")
          .then((r) => r.json())
          .then((d) => setRoster(d.success ? (d.data?.rows ?? []) : null));
      })
      .catch(() => setRoster(null));
  }, []);

  const steps: WizardStep[] = [
    {
      key: "demographics",
      title: "Demographics",
      description: "Basic identity information for the patient record.",
      isValid: () =>
        Boolean(
          data.demographics.firstName &&
            data.demographics.lastName &&
            data.demographics.dateOfBirth,
        ),
      render: () => {
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field id="first" label="First name" required>
              <TextInput
                id="first"
                value={data.demographics.firstName}
                onChange={(e) => setDemographics("firstName", e.target.value)}
                autoComplete="given-name"
              />
            </Field>
            <Field id="last" label="Last name" required>
              <TextInput
                id="last"
                value={data.demographics.lastName}
                onChange={(e) => setDemographics("lastName", e.target.value)}
                autoComplete="family-name"
              />
            </Field>
            <Field id="dob" label="Date of birth" required hint="YYYY-MM-DD">
              <TextInput
                id="dob"
                type="date"
                value={data.demographics.dateOfBirth}
                onChange={(e) => setDemographics("dateOfBirth", e.target.value)}
              />
            </Field>
            <Field id="sex" label="Sex assigned at birth" optional>
              <Select
                id="sex"
                value={data.demographics.sexAssignedAtBirth ?? ""}
                onChange={(e) =>
                  setDemographics(
                    "sexAssignedAtBirth",
                    (e.target.value || undefined) as
                      | "M"
                      | "F"
                      | "X"
                      | "unknown"
                      | undefined,
                  )
                }
              >
                <option value="">—</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
                <option value="X">X / non-binary</option>
                <option value="unknown">Unknown</option>
              </Select>
            </Field>
            <Field id="addr" label="Address" optional>
              <TextInput
                id="addr"
                value={data.demographics.addressLine1 ?? ""}
                onChange={(e) =>
                  setDemographics("addressLine1", e.target.value || undefined)
                }
                autoComplete="street-address"
              />
            </Field>
            <Field id="city" label="City" optional>
              <TextInput
                id="city"
                value={data.demographics.city ?? ""}
                onChange={(e) =>
                  setDemographics("city", e.target.value || undefined)
                }
                autoComplete="address-level2"
              />
            </Field>
            <Field id="state" label="State" optional hint="USPS 2-letter">
              <TextInput
                id="state"
                maxLength={2}
                value={data.demographics.state ?? ""}
                onChange={(e) =>
                  setDemographics(
                    "state",
                    (e.target.value.toUpperCase() || undefined) as string | undefined,
                  )
                }
                className="uppercase tabular w-24"
                autoComplete="address-level1"
              />
            </Field>
            <Field id="zip" label="ZIP" optional>
              <TextInput
                id="zip"
                value={data.demographics.zip ?? ""}
                onChange={(e) =>
                  setDemographics("zip", e.target.value || undefined)
                }
                className="tabular w-32"
                autoComplete="postal-code"
              />
            </Field>
            <Field id="phone" label="Phone" optional>
              <TextInput
                id="phone"
                type="tel"
                value={data.demographics.phone ?? ""}
                onChange={(e) =>
                  setDemographics("phone", e.target.value || undefined)
                }
                autoComplete="tel"
              />
            </Field>
            <Field id="ec-name" label="Emergency contact name" optional>
              <TextInput
                id="ec-name"
                value={data.demographics.emergencyContactName ?? ""}
                onChange={(e) =>
                  setDemographics(
                    "emergencyContactName",
                    e.target.value || undefined,
                  )
                }
              />
            </Field>
          </div>
        );
      },
    },
    {
      key: "insurance",
      title: "Insurance",
      description:
        "Which insurance organization covers this patient, and in which state. This is what Pallio uses to show the right billing codes at the point of care.",
      // Both empty is allowed (insurance often isn't known at intake). A HALF-set
      // pair is not: payer-without-state (or the reverse) silently breaks every
      // coverage lookup, which is worse than knowing nothing.
      isValid: () =>
        Boolean(data.insurance.primaryPayerId) === Boolean(data.insurance.insuranceState),
      render: () => {
        const selectedPayer = payers.find((p) => p.id === data.insurance.primaryPayerId);
        const noneSet = !data.insurance.primaryPayerId && !data.insurance.insuranceState;
        const halfSet =
          Boolean(data.insurance.primaryPayerId) !== Boolean(data.insurance.insuranceState);
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {noneSet && (
              <p className="md:col-span-2 text-sm text-amber-800 bg-amber-50 ring-1 ring-inset ring-amber-600/30 rounded-md px-3 py-2">
                No insurance yet? You can continue — but until a payer and state
                are set, Pallio can&rsquo;t show payer-specific coverage rules or
                flag likely denials for this patient.
              </p>
            )}
            {halfSet && (
              <p
                role="alert"
                className="md:col-span-2 text-sm text-red-700 bg-red-50 ring-1 ring-inset ring-red-600/30 rounded-md px-3 py-2"
              >
                Coverage rules need both the organization and the state. Set both,
                or clear both.
              </p>
            )}
            <Field
              id="payer-id"
              label="Insurance organization"
              recommended
              explain="Pallio uses the payer plus the coverage state to show only the codes that payer accepts, and to warn before a claim is likely to be denied. Without it, coding falls back to unfiltered lists."
            >
              <Select
                id="payer-id"
                value={data.insurance.primaryPayerId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || undefined;
                  setInsurance("primaryPayerId", id);
                  // Default the policy state to the payer's state when it only
                  // serves one — saves a keystroke and avoids a mismatched pair.
                  const p = payers.find((x) => x.id === id);
                  if (p && p.states.length === 1 && !data.insurance.insuranceState) {
                    setInsurance("insuranceState", p.states[0]);
                  }
                }}
              >
                <option value="">Select…</option>
                {payers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.states.length > 0 ? ` · ${p.states.join("/")}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="ins-state"
              label="Coverage state"
              recommended
              hint={
                selectedPayer && selectedPayer.states.length > 0
                  ? `${selectedPayer.name} covers ${selectedPayer.states.join(", ")}`
                  : "USPS 2-letter — the state the policy is issued in."
              }
            >
              <TextInput
                id="ins-state"
                maxLength={2}
                placeholder={data.demographics.state ?? "OH"}
                value={data.insurance.insuranceState ?? ""}
                onChange={(e) =>
                  setInsurance(
                    "insuranceState",
                    e.target.value.toUpperCase() || undefined,
                  )
                }
                className="uppercase"
              />
            </Field>
            <Field id="mem-id" label="Member ID" optional>
              <TextInput
                id="mem-id"
                value={data.insurance.primaryMemberId ?? ""}
                onChange={(e) =>
                  setInsurance(
                    "primaryMemberId",
                    e.target.value || undefined,
                  )
                }
              />
            </Field>
            <Field id="grp" label="Group number" optional>
              <TextInput
                id="grp"
                value={data.insurance.primaryGroupNumber ?? ""}
                onChange={(e) =>
                  setInsurance(
                    "primaryGroupNumber",
                    e.target.value || undefined,
                  )
                }
              />
            </Field>
            <Field id="eff" label="Coverage effective" optional hint="YYYY-MM-DD">
              <TextInput
                id="eff"
                type="date"
                value={data.insurance.insuranceEffectiveDate ?? ""}
                onChange={(e) =>
                  setInsurance(
                    "insuranceEffectiveDate",
                    e.target.value || undefined,
                  )
                }
              />
            </Field>
          </div>
        );
      },
    },
    {
      key: "clinical",
      title: "Clinical",
      description: "Primary diagnosis and palliative referral context.",
      optional: true,
      render: () => {
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field id="icd" label="Primary diagnosis (ICD-10)" optional>
                <TextInput
                  id="icd"
                  value={data.clinical.primaryDiagnosisIcd10 ?? ""}
                  onChange={(e) =>
                    setClinical(
                      "primaryDiagnosisIcd10",
                      e.target.value.toUpperCase() || undefined,
                    )
                  }
                  className="font-mono text-sm uppercase"
                  placeholder="C50.911"
                />
              </Field>
              <Field id="ref-npi" label="Referring physician NPI" optional>
                <TextInput
                  id="ref-npi"
                  value={data.clinical.referringPhysicianNpi ?? ""}
                  onChange={(e) =>
                    setClinical(
                      "referringPhysicianNpi",
                      e.target.value || undefined,
                    )
                  }
                  className="tabular slashed-zero"
                />
              </Field>
              <Field id="ref-name" label="Referring physician name" optional>
                <TextInput
                  id="ref-name"
                  value={data.clinical.referringPhysicianName ?? ""}
                  onChange={(e) =>
                    setClinical(
                      "referringPhysicianName",
                      e.target.value || undefined,
                    )
                  }
                />
              </Field>
              <Field id="acuity" label="Acuity" optional>
                <select
                  id="acuity"
                  value={data.clinical.acuity ?? ""}
                  onChange={(e) =>
                    setClinical(
                      "acuity",
                      (e.target.value || undefined) as CreatePatient["clinical"]["acuity"],
                    )
                  }
                  className="h-10 w-full px-3 rounded-md border border-slate-300 bg-white text-sm"
                >
                  <option value="">— unassigned —</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </Field>
            </div>
            <Field id="reason" label="Reason for palliative referral" optional>
              <TextArea
                id="reason"
                rows={3}
                value={data.clinical.palliativeReferralReason ?? ""}
                onChange={(e) =>
                  setClinical(
                    "palliativeReferralReason",
                    e.target.value || undefined,
                  )
                }
              />
            </Field>
          </div>
        );
      },
    },
    {
      key: "consents",
      title: "Consents",
      description:
        "Required acknowledgments. Capture electronic signature in person and check each box.",
      isValid: () =>
        data.consents.hipaaAcknowledged && data.consents.goalsOfCareConsent,
      render: () => {
        return (
          <div className="space-y-4">
            <CheckboxRow
              id="hipaa"
              checked={data.consents.hipaaAcknowledged}
              onChange={(v) => setConsents("hipaaAcknowledged", v)}
              label="HIPAA notice acknowledged"
              required
            />
            <CheckboxRow
              id="goc"
              checked={data.consents.goalsOfCareConsent}
              onChange={(v) => setConsents("goalsOfCareConsent", v)}
              label="Goals of care conversation consent"
              required
            />
            <CheckboxRow
              id="tlh"
              checked={data.consents.telehealthConsent}
              onChange={(v) => setConsents("telehealthConsent", v)}
              label="Telehealth consent"
              explain="Required only if the patient may receive telehealth visits. Without it, telehealth visit types can't be billed for this patient."
            />
          </div>
        );
      },
    },
    {
      key: "care-team",
      title: "Care team",
      description: "Assign the clinicians and billing agent. All optional — edit later from the patient page.",
      optional: true,
      render: () => {
        if (roster === null) {
          return (
            <p className="text-sm text-slate-600">
              Care-team assignment needs the patients.careteam.edit permission
              (org admins have it). The patient will be created unassigned —
              the team can be assigned from the patient detail page afterwards.
            </p>
          );
        }
        const seats = [
          ["Primary NP", "primaryNpUserId"],
          ["RN", "rnUserId"],
          ["Social worker", "socialWorkerUserId"],
          ["Billing agent", "billingAgentUserId"],
        ] as const;
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {seats.map(([label, key]) => (
              <Field key={key} id={`care-team-${key}`} label={label} optional>
                <Select
                  id={`care-team-${key}`}
                  value={data.careTeam[key] ?? ""}
                  onChange={(e) =>
                    setCareTeam(key, e.target.value || undefined)
                  }
                >
                  <option value="">— unassigned —</option>
                  {roster.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName ?? m.email}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
        );
      },
    },
  ];

  async function complete() {
    const parsed = CreatePatientSchema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${issue.path.join(".")}: ${issue.message}`,
      );
    }
    const res = await fetch("/api/patients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error ?? "Create failed.");
    router.push(`/patients/${body.data.id}`);
  }

  return (
    <div className="px-8 py-8">
      <Wizard
        steps={steps}
        onCancel={() => router.push("/patients")}
        onComplete={complete}
        finishLabel="Create patient"
      />
    </div>
  );
}

function CheckboxRow({
  id,
  checked,
  onChange,
  label,
  explain,
  required,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  /** Long explanation — shown from an ⓘ, not inline (walkthrough 02:03). */
  explain?: string;
  required?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 px-3 py-2 rounded-md border border-slate-200 hover:border-slate-300 cursor-pointer"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <span className="text-sm">
        <span className="font-medium text-slate-900">
          {label}
          {required && (
            <>
              <span className="text-red-600 ml-1" aria-hidden>
                *
              </span>
              <span className="sr-only"> required</span>
            </>
          )}
          {explain && <InfoTip label={`About ${label}`}>{explain}</InfoTip>}
        </span>
      </span>
    </label>
  );
}
