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
 *
 * ?referralId= admits a referral (Level-1 doc:25, 0111): the wizard opens with
 * what intake took down on it, and the patient is created with the referral's
 * id, which marks the referral admitted in the same transaction.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { EthnicityField, LanguageField, RacePicker } from "@/components/patients/demographic-fields";
import { InfoTip } from "@/components/ui/info-tip";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
  CONTACT_RELATIONSHIPS,
  CONTACT_RELATIONSHIP_LABELS,
  type ContactRelationship,
} from "@/lib/features/patients/contacts.types";
import { coverageGap } from "@/lib/features/patients/coverage-gap";
import { checkCoveragePair } from "@/lib/features/patients/insurance-pure";
import {
  CreatePatientSchema,
  type CreatePatient,
} from "@/lib/features/patients/patient.types";
import { isOpenStage, type ReferralView } from "@/lib/features/referrals/referral.types";
import { isValidNpi } from "@/lib/features/team/clinician";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * The intake a referral starts: what was taken down on it. The plan and member
 * ID are the referral's; the coverage start comes from its latest active check
 * of that same plan. A plan sold in one state fills the coverage state, as
 * picking it does.
 */
function fromReferral(r: ReferralView, payers: { id: string; states: string[] }[]): CreatePatient {
  const opt = (s: string | null) => s ?? undefined;
  const check = r.verifications.find((v) => v.result === "active" && (!r.payerId || v.payerId === r.payerId));
  const payerId = r.payerId ?? check?.payerId ?? null;
  const payer = payers.find((p) => p.id === payerId);
  return {
    ...EMPTY,
    demographics: {
      ...EMPTY.demographics,
      firstName: r.firstName,
      lastName: r.lastName,
      dateOfBirth: r.dateOfBirth ?? "",
      phone: opt(r.phone),
    },
    insurance: {
      primaryPayerId: opt(payerId),
      insuranceState: payer && payer.states.length === 1 ? payer.states[0] : undefined,
      primaryMemberId: opt(r.memberId ?? check?.memberId ?? null),
      insuranceEffectiveDate: opt(check?.coverageEffectiveOn ?? null),
    },
    clinical: {
      primaryDiagnosisIcd10: opt(r.primaryDiagnosisIcd10),
      referringPhysicianName: opt(r.referringProviderName),
      referringPhysicianNpi: opt(r.referringProviderNpi),
      palliativeReferralReason: opt(r.reason),
      // The triage's preliminary acuity, until the NP's visit sets its own.
      acuity: r.latestAcuity ?? undefined,
    },
    referralId: r.id,
  };
}

export default function NewPatientPage({
  searchParams,
}: {
  searchParams: Promise<{ referralId?: string | string[] }>;
}) {
  const router = useRouter();
  const asked = use(searchParams).referralId;
  const referralId = typeof asked === "string" && UUID.test(asked) ? asked : null;
  const [data, setData] = useState<CreatePatient>(EMPTY);
  // The referral this intake admits, once read.
  const [referral, setReferral] = useState<ReferralView | null>(null);
  const [referralProblem, setReferralProblem] = useState<string | null>(null);
  const [referralLoading, setReferralLoading] = useState(referralId !== null);
  useEffect(() => {
    if (!referralId) return;
    let abandoned = false;
    Promise.all([
      fetch(`/api/referrals/${referralId}`).then((r) => r.json()),
      fetch("/api/billing/payers")
        .then((r) => r.json())
        .catch(() => null),
    ])
      .then(([d, p]) => {
        if (abandoned) return;
        if (!d.success) {
          setReferralProblem(d.error ?? "Referral not found.");
          return;
        }
        const r: ReferralView = d.data;
        setReferral(r);
        if (r.stage === "admitted") {
          setReferralProblem("This referral was already admitted.");
          return;
        }
        if (!isOpenStage(r.stage)) {
          setReferralProblem("This referral is closed. Reopen it before admitting.");
          return;
        }
        setData(fromReferral(r, p?.success ? (p.data?.payers ?? []) : []));
      })
      .catch(() => {
        if (!abandoned) setReferralProblem("Network error — the referral did not load.");
      })
      .finally(() => {
        if (!abandoned) setReferralLoading(false);
      });
    return () => {
      abandoned = true;
    };
  }, [referralId]);

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
  // ruleStates: where Pallio holds live rules for the payer (audit R17), for the
  // no-rules note under Coverage state.
  const [payers, setPayers] = useState<
    { id: string; name: string; states: string[]; ruleStates?: string[] }[]
  >([]);
  // The payers this practice picked at onboarding, offered first. The list
  // held every payer in OH, NC and SC, the practice's own among 19 others.
  const [orgPayerIds, setOrgPayerIds] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return;
        const list = d.data?.payers ?? d.data?.rows ?? [];
        setPayers(Array.isArray(list) ? list : []);
        setOrgPayerIds(Array.isArray(d.data?.orgPayerIds) ? d.data.orgPayerIds : []);
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
  // An acuity is a clinical judgment, gated as the POST gates it. A triage's,
  // carried over from the referral, shows here without being theirs to change.
  const [canGiveAcuity, setCanGiveAcuity] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((me) => {
        setCanGiveAcuity(
          me.success &&
            ((me.data?.permissions ?? []).includes("patient.acuity.edit") || me.data?.role === "platform_admin"),
        );
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

  // The emergency contact becomes the first Family & caregivers entry (audit
  // R30), which needs a name: a phone or relationship alone is refused by the
  // server, so the step refuses it first.
  const ecNeedsName =
    !data.demographics.emergencyContactName?.trim() &&
    Boolean(data.demographics.emergencyContactPhone || data.demographics.emergencyContactRelationship);
  const refNpi = data.clinical.referringPhysicianNpi?.trim() ?? "";

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
        ) && !ecNeedsName,
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
            {/* No format hint: it's a native date input, so the browser
                already shows the format. */}
            <Field id="dob" label="Date of birth" required>
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
            <div className="md:col-span-2">
              <RacePicker
                idPrefix="race"
                value={data.demographics.raceCodes ?? []}
                onChange={(codes) => setDemographics("raceCodes", codes.length > 0 ? codes : undefined)}
              />
            </div>
            <EthnicityField
              id="ethnicity"
              value={data.demographics.ethnicity ?? ""}
              onChange={(e) => setDemographics("ethnicity", e.target.value || undefined)}
            />
            <LanguageField
              id="language"
              value={data.demographics.preferredLanguage ?? ""}
              onChange={(e) => setDemographics("preferredLanguage", e.target.value || undefined)}
            />
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
            {/* The specimen the client selected at [00:59] and told us to
                delete. The guidance now lives behind the ⓘ. */}
            <Field
              id="state"
              label="State"
              optional
              explain="Two-letter USPS abbreviation — Ohio is OH."
            >
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
            <Field
              id="ec-name"
              label="Emergency contact name"
              optional
              explain="Saved to the patient's Family & caregivers, where more family, caregivers and a healthcare POA can be added after intake."
              error={ecNeedsName ? "Add a name, or clear the phone and relationship." : undefined}
            >
              <TextInput
                id="ec-name"
                value={data.demographics.emergencyContactName ?? ""}
                invalid={ecNeedsName}
                autoComplete="off"
                onChange={(e) =>
                  setDemographics(
                    "emergencyContactName",
                    e.target.value || undefined,
                  )
                }
              />
            </Field>
            <Field id="ec-phone" label="Emergency contact phone" optional>
              <TextInput
                id="ec-phone"
                type="tel"
                autoComplete="off"
                value={data.demographics.emergencyContactPhone ?? ""}
                onChange={(e) =>
                  setDemographics("emergencyContactPhone", e.target.value || undefined)
                }
              />
            </Field>
            <Field id="ec-relationship" label="Relationship to patient" optional>
              <Select
                id="ec-relationship"
                value={data.demographics.emergencyContactRelationship ?? ""}
                onChange={(e) =>
                  setDemographics(
                    "emergencyContactRelationship",
                    (e.target.value || undefined) as ContactRelationship | undefined,
                  )
                }
              >
                <option value="">—</option>
                {CONTACT_RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>
                    {CONTACT_RELATIONSHIP_LABELS[r]}
                  </option>
                ))}
              </Select>
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
      // coverage lookup, which is worse than knowing nothing. Nor is a pair the
      // payer does not cover (audit R37), for the same reason.
      isValid: () => {
        if (Boolean(data.insurance.primaryPayerId) !== Boolean(data.insurance.insuranceState)) {
          return false;
        }
        const payer = payers.find((p) => p.id === data.insurance.primaryPayerId);
        return (
          !payer ||
          checkCoveragePair(
            { name: payer.name, statesServed: payer.states },
            data.insurance.insuranceState,
          ) === null
        );
      },
      render: () => {
        const selectedPayer = payers.find((p) => p.id === data.insurance.primaryPayerId);
        const noneSet = !data.insurance.primaryPayerId && !data.insurance.insuranceState;
        const halfSet =
          Boolean(data.insurance.primaryPayerId) !== Boolean(data.insurance.insuranceState);
        // not_served is the sentence the server refuses with (audit R37), so
        // the form and the API agree, and isValid above still blocks on it.
        // no_rules is a note, never a block (audit R17): the payer is listed
        // for the state but Pallio holds no live rules there yet.
        const gap = coverageGap(selectedPayer, data.insurance.insuranceState);
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
            {gap?.kind === "not_served" && (
              <p
                role="alert"
                className="md:col-span-2 text-sm text-red-700 bg-red-50 ring-1 ring-inset ring-red-600/30 rounded-md px-3 py-2"
              >
                {gap.message}
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
                  // Keep the state only if the new payer covers it (audit R37);
                  // a payer that serves a single state fills it in.
                  const p = payers.find((x) => x.id === id);
                  const cur = data.insurance.insuranceState;
                  if (p && p.states.length > 0 && (!cur || !p.states.includes(cur))) {
                    setInsurance("insuranceState", p.states.length === 1 ? p.states[0] : undefined);
                  }
                }}
              >
                <option value="">Select…</option>
                {(() => {
                  const option = (p: (typeof payers)[number]) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.states.length > 0 ? ` · ${p.states.join("/")}` : ""}
                    </option>
                  );
                  const ours = payers.filter((p) => orgPayerIds.includes(p.id));
                  if (ours.length === 0) return payers.map(option);
                  return (
                    <>
                      <optgroup label="Your practice's payers">{ours.map(option)}</optgroup>
                      <optgroup label="Other payers">
                        {payers.filter((p) => !orgPayerIds.includes(p.id)).map(option)}
                      </optgroup>
                    </>
                  );
                })()}
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
              {selectedPayer && selectedPayer.states.length > 0 ? (
                // Only the states this payer covers can be picked (audit R37).
                // A free two-letter box let CareSource Ohio be paired with UT.
                <Select
                  id="ins-state"
                  value={data.insurance.insuranceState ?? ""}
                  onChange={(e) => setInsurance("insuranceState", e.target.value || undefined)}
                >
                  <option value="">Select…</option>
                  {selectedPayer.states.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              ) : (
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
              )}
            </Field>
            {gap?.kind === "no_rules" && (
              // Amber, not an alert: the pair is valid and the wizard goes on.
              // It says now why every lookup for this patient will be a
              // benchmark, instead of leaving that to be found out later.
              <p className="md:col-span-2 text-sm text-amber-800 bg-amber-50 ring-1 ring-inset ring-amber-600/30 rounded-md px-3 py-2">
                {gap.message}
              </p>
            )}
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
            <Field id="eff" label="Coverage effective" optional>
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
              <Field
                id="ref-npi"
                label="Referring physician NPI"
                optional
                explain="The referring physician joins your outside-provider roster. With an NPI they stay one entry, however many patients they refer."
                error={refNpi && !isValidNpi(refNpi) ? "Ten digits with a valid check digit." : undefined}
              >
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
                  disabled={!canGiveAcuity}
                  value={data.clinical.acuity ?? ""}
                  onChange={(e) =>
                    setClinical(
                      "acuity",
                      (e.target.value || undefined) as CreatePatient["clinical"]["acuity"],
                    )
                  }
                  className="h-10 w-full px-3 rounded-md border border-slate-300 bg-white text-sm disabled:bg-slate-50 disabled:text-slate-600"
                >
                  <option value="">— unassigned —</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
                {!canGiveAcuity && (
                  <p className="text-xs text-slate-500 mt-1">A nurse or clinician gives the acuity.</p>
                )}
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
              explain="Recorded on the chart; pre-fills the consent acknowledgment on this patient's telehealth visits."
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
          ["Chaplain", "chaplainUserId"],
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

  if (referralId && referralLoading) {
    return <div className="px-8 py-8 text-slate-500">Loading the referral…</div>;
  }
  // Admitting a referral that is not open would fail at the last step; it is
  // said now, with the way back, rather than after five steps of typing.
  if (referralId && (referralProblem || !referral)) {
    return (
      <div className="px-8 py-8 max-w-2xl">
        <p role="alert" className="text-red-700">
          {referralProblem ?? "Referral not found."}
        </p>
        <div className="mt-4 flex gap-4 text-sm">
          {referral?.patientId && (
            <Link href={`/patients/${referral.patientId}`} className="text-[var(--color-brand-700)] underline">
              Open the chart
            </Link>
          )}
          {referral && (
            <Link href={`/referrals/${referral.id}`} className="text-[var(--color-brand-700)] underline">
              Back to the referral
            </Link>
          )}
          <Link href="/referrals" className="text-[var(--color-brand-700)] underline">
            Referrals
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 py-8">
      {referral && (
        <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Admitting the referral for{" "}
          <strong>
            {referral.firstName} {referral.lastName}
          </strong>
          , received {referral.receivedOn}
          {referral.sourceName ? ` from ${referral.sourceName}` : ""}. What intake took down is filled in; creating
          the patient marks the referral admitted.{" "}
          <Link href={`/referrals/${referral.id}`} className="underline">
            Back to the referral
          </Link>
        </div>
      )}
      <Wizard
        steps={steps}
        onCancel={() => router.push(referral ? `/referrals/${referral.id}` : "/patients")}
        onComplete={complete}
        finishLabel={referral ? "Create patient and admit" : "Create patient"}
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
