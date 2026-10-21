/**
 * A clinician's billing identity: individual NPI and licensure credential.
 *
 * Audit R40: every claim put the ORGANIZATION's onboarding NPI in the
 * rendering-provider slot — or an empty string when onboarding never captured
 * one — because no person-level NPI existed anywhere. A rendering provider is
 * the individual who performed the service (a Type 1 NPI); the organization is
 * the billing provider. Conflating them misidentifies who treated the patient.
 *
 * Audit R25: the pricing tier (MD vs NP/PA) was a per-visit dropdown nothing
 * read, so every claim priced at the NP/PA rate whoever saw the patient. Tier
 * is a property of the clinician's licence, not of a visit, so it is derived
 * from the credential recorded here.
 *
 * Pure — no IO — so it is safe to import from client components and tests.
 */
import type { ProviderTier } from "@/lib/features/superbills/superbill-pure";

export const CLINICIAN_CREDENTIALS = [
  "MD", "DO", "NP", "PA", "CNS", "RN", "LCSW", "OTHER",
] as const;
export type ClinicianCredential = (typeof CLINICIAN_CREDENTIALS)[number];

export const CREDENTIAL_LABEL: Record<ClinicianCredential, string> = {
  MD: "Physician (MD)",
  DO: "Physician (DO)",
  NP: "Nurse practitioner",
  PA: "Physician assistant",
  CNS: "Clinical nurse specialist",
  RN: "Registered nurse",
  LCSW: "Social worker (LCSW)",
  OTHER: "Other",
};

/**
 * Does this look like a real NPI? Ten digits whose last is the Luhn check
 * digit computed over "80840" + the first nine — the rule CMS publishes for
 * NPI assignment. Catches transposed and mistyped digits before a payer does.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const payload = ("80840" + npi.slice(0, 9)).split("").map(Number);
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    // Double every second digit counting from the right of the payload.
    let d = payload[payload.length - 1 - i]!;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

/**
 * The Medicare pricing tier a credential bills at, or null when the
 * credential does not bill home E/M services at all.
 *
 * Physicians bill at 100% of the fee schedule; NPs, PAs and CNSs at 85%.
 * RNs and social workers do not bill E/M codes — null tells the caller to
 * warn rather than silently price them.
 */
export function tierForCredential(
  credential: ClinicianCredential | string | null | undefined,
): ProviderTier | null {
  switch (credential) {
    case "MD":
    case "DO":
      return "MD";
    case "NP":
    case "PA":
    case "CNS":
      return "NP_PA";
    default:
      return null;
  }
}

/** Where a claim's rendering NPI came from. */
export type NpiSource = "clinician" | "organization" | "none";

/**
 * Warnings about WHO a claim names, for the draft and for a saved bill.
 *
 * The rendering NPI may fall back to the organization's onboarding NPI while a
 * clinician has none recorded, so solo practices that entered their own number
 * at onboarding do not regress. That fallback must never be silent — the audit
 * finding was precisely that the org's number went out "with no warning".
 *
 * When `npiSource` is not known (a saved row), it is inferred: no NPI means
 * none; an NPI equal to the billing NPI means the organization's.
 * `credential === undefined` means "not looked up" and produces no warning;
 * `null` means looked up and never recorded.
 */
export function providerIdentityWarnings(p: {
  npi: string;
  fullName: string;
  billingNpi?: string;
  npiSource?: NpiSource;
  credential?: string | null;
}): string[] {
  const name = p.fullName?.trim() || "the rendering clinician";
  const source: NpiSource =
    p.npiSource ??
    (!p.npi ? "none" : p.billingNpi && p.npi === p.billingNpi ? "organization" : "clinician");

  const out: string[] = [];
  if (source === "none" || !p.npi) {
    out.push(
      `No NPI on file for ${name} — add it on the Team page. A claim without a rendering-provider NPI is rejected.`,
    );
  } else {
    if (source === "organization") {
      out.push(
        `Rendering NPI is the organization's NPI from onboarding, not ${name}'s own — add ${name}'s NPI on the Team page.`,
      );
    }
    if (!isValidNpi(p.npi)) {
      out.push(`Rendering NPI ${p.npi} fails the NPI check digit — confirm it before submitting.`);
    }
  }

  if (p.credential === null) {
    out.push(`${name}'s credential isn't set on the Team page — priced at the NP/PA rate.`);
  } else if (p.credential !== undefined && tierForCredential(p.credential) === null) {
    out.push(
      `${name} is recorded as ${p.credential}. Home E/M codes are billed by a physician, NP, PA or CNS.`,
    );
  }
  return out;
}
