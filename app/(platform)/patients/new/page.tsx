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
import { useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
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
      description: "Primary payer + member ID. We'll use this for rule lookups.",
      optional: true,
      render: () => {
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field id="payer-id" label="Primary payer ID" optional hint="UUID — pick from the payer dropdown later">
              <TextInput
                id="payer-id"
                value={data.insurance.primaryPayerId ?? ""}
                onChange={(e) =>
                  setInsurance(
                    "primaryPayerId",
                    e.target.value || undefined,
                  )
                }
                className="font-mono text-xs"
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
              hint="Required only if the patient may receive telehealth visits."
            />
          </div>
        );
      },
    },
    {
      key: "care-team",
      title: "Care team",
      description: "Per-patient assignment is coming; clinicians are assigned per visit for now.",
      optional: true,
      render: () => {
        return (
          <p className="text-sm text-slate-600">
            Care team assignment goes here in the next iteration. Today, the
            patient is created unassigned — clinicians are assigned per visit
            when scheduling (Schedule → New visit).
          </p>
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
  hint,
  required,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
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
        </span>
        {hint && <span className="block text-slate-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}
