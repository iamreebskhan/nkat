/**
 * A Pallio claim as an 837P claim (0120): what goes in each loop, and what
 * stops a claim from going at all.
 *
 * Pure and client-safe, so the queue can say why a claim cannot be sent
 * before anyone presses Send, and the service enforces the same list.
 *
 * STOPS are what a clearinghouse's front-end edits reject outright: the
 * export's three (member ID, diagnosis, CPT — Mark Q5 default), plus what an
 * 837P cannot be written without: the payer's ID at this clearinghouse, the
 * billing provider's NPI, EIN and street address with all nine ZIP digits
 * (TR3 2010AA N403), the rendering NPI, the patient's date of birth and
 * address (the patient is the subscriber, 2010BA), the place of service, and
 * valid codes, modifiers and units.
 *
 * WARNINGS go out with the claim and are said once: no taxonomy (PRV is
 * situational), a place of service whose facility the claim does not name, a
 * sex the chart does not record (sent as U), more than 12 diagnoses (12 go),
 * a $0 line, a refile without the payer's claim number (sent as a new claim),
 * and a box 17 left empty on a practice that fills it (0123).
 */
import type { ReferringResult } from "@/lib/features/billing/claim-referring";
import { normalizeUnits, unitsOf, type CodeUnits } from "@/lib/features/billing/code-units";
import { lineModifiers } from "@/lib/features/billing/visit-complexity";

import type { ConnectionSettings } from "./connection-settings";
import { FILING_INDICATOR_BY_PAYER_TYPE } from "./vendors";
import type { Claim837, X12Address } from "./x12/x12-837p";

export interface Address {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
}

/** A claim as Pallio holds it, read for one file. */
export interface ClaimSource {
  superbillId: string;
  claimRef: string;
  status: string;
  dateOfService: string;
  placeOfService: string | null;
  codes: string[];
  units: CodeUnits;
  modifiers: string[];
  icd10: string[];
  /** Per code: the line's charge in cents. */
  chargeCents: Record<string, number>;
  patient: { lastName: string; firstName: string; dob: string | null; sex: string | null; address: Address | null };
  memberId: string;
  groupNumber: string | null;
  payer: { id: string; name: string; type: string } | null;
  rendering: { name: string; npi: string; taxonomy: string | null };
  billing: { name: string | null; npi: string | null; ein: string | null; taxonomy: string | null; address: Address | null; payTo: Address | null };
  /** Box 17 (0123), resolved by claim-referring.ts; absent when the practice leaves it off. */
  referring?: ReferringResult;
  /** Box 23 (0124): the prior authorization on the chart that covers this claim. */
  priorAuthNumber?: string | null;
  /**
   * The payer's own number for this claim, when the payer has processed it
   * before (an 835's CLP07, a 277CA's REF*1K): a refile replaces that claim.
   */
  priorPayerClaimNumber: string | null;
}

export interface PayerIdMapping {
  externalPayerId: string;
  claimFilingIndicator: string | null;
}

export interface Mapped837 {
  claim: Claim837 | null;
  stops: string[];
  warnings: string[];
}

/** NPIs carry a Luhn check digit over "80840" + the first nine digits. */
export function npiValid(npi: string | null | undefined): boolean {
  const d = (npi ?? "").replace(/\D/g, "");
  if (!/^[12]\d{9}$/.test(d)) return false;
  const digits = `80840${d.slice(0, 9)}`.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = digits[digits.length - 1 - i]!;
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

/** "Helen Okafor" → Okafor / Helen; a credential after a comma is not a name. */
export function splitPersonName(full: string): { firstName: string; lastName: string } {
  const name = full.split(",")[0]!.trim().replace(/\s+/g, " ");
  const parts = name.split(" ");
  if (parts.length === 1) return { firstName: "", lastName: parts[0] ?? "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1]! };
}

/** Places of service whose facility a payer may expect named (2310C), which Pallio does not record yet. */
const FACILITY_POS = new Set(["13", "14", "31", "32", "33", "34"]);

/** Where each gap in a claim is put right, as the screens are named. */
const FIX_AT = {
  insurance: "patient's chart → Insurance",
  identity: "patient's chart → Identity",
  bill: "the bill",
  billing: "Settings → Billing provider",
  team: "Team page",
  payerIds: "Settings → Integrations → Payer IDs",
} as const;

const SEX = (s: string | null): "F" | "M" | "U" => (s === "F" || s === "M" ? s : "U");

function toX12Address(a: Address): X12Address {
  return { line1: a.line1, line2: a.line2 ?? null, city: a.city, state: a.state, zip: a.zip };
}

export function claimTo837(c: ClaimSource, ctx: { settings: ConnectionSettings; vendorName: string; payerId: PayerIdMapping | null }): Mapped837 {
  const stops: string[] = [];
  const warnings: string[] = [];

  // Each gap says where it is put right, so the person reading the refusal
  // knows which screen to open.
  if (!c.memberId.trim()) stops.push(`no member ID (${FIX_AT.insurance})`);
  if (c.icd10.length === 0) stops.push(`no diagnosis (${FIX_AT.bill})`);
  if (c.codes.length === 0) stops.push(`no CPT code (${FIX_AT.bill})`);
  if (!c.payer) stops.push(`no payer (${FIX_AT.insurance})`);
  else if (!ctx.payerId) stops.push(`no ${ctx.vendorName} payer ID for ${c.payer.name} (${FIX_AT.payerIds})`);
  if (!c.placeOfService || !/^\d{2}$/.test(c.placeOfService)) stops.push(`no place of service (${FIX_AT.bill})`);

  const b = c.billing;
  if (!b.name) stops.push(`no billing provider name (${FIX_AT.billing})`);
  if (!npiValid(b.npi)) stops.push(b.npi ? `a billing NPI that fails its check digit (${FIX_AT.billing})` : `no billing NPI (${FIX_AT.billing})`);
  if (!b.ein || !/^\d{9}$/.test(b.ein.replace(/\D/g, ""))) stops.push(`no EIN (${FIX_AT.billing})`);
  if (!b.address) stops.push(`no billing address (${FIX_AT.billing})`);
  else if (b.address.zip.replace(/\D/g, "").length !== 9) stops.push(`a billing ZIP without its last four digits; claims need all nine (${FIX_AT.billing})`);
  if (!b.taxonomy) warnings.push(`no billing taxonomy (${FIX_AT.billing})`);

  if (!npiValid(c.rendering.npi)) stops.push(c.rendering.npi ? `a rendering NPI that fails its check digit (${FIX_AT.team})` : `no rendering NPI (${FIX_AT.team})`);
  if (!c.rendering.taxonomy) warnings.push(`no taxonomy for the clinician (${FIX_AT.team})`);
  const rendering = splitPersonName(c.rendering.name);
  if (!rendering.lastName) stops.push(`no rendering provider name (${FIX_AT.team})`);

  if (!c.patient.dob) stops.push(`no patient date of birth (${FIX_AT.identity})`);
  if (!c.patient.address) stops.push(`no patient address (${FIX_AT.identity})`);
  else if (![5, 9].includes(c.patient.address.zip.replace(/\D/g, "").length)) stops.push(`a patient ZIP that isn't 5 or 9 digits (${FIX_AT.identity})`);
  if (!c.patient.sex || !["F", "M"].includes(c.patient.sex)) warnings.push("no patient sex on the chart (sent as unknown)");

  if (c.placeOfService && FACILITY_POS.has(c.placeOfService)) {
    warnings.push(`place of service ${c.placeOfService}: the payer may ask for the facility's name and address, which the claim doesn't include`);
  }
  if (c.icd10.length > 12) warnings.push(`${c.icd10.length} diagnoses; only the first 12 are sent`);
  if (c.referring?.warning) warnings.push(c.referring.warning);

  const units = normalizeUnits(c.codes, c.units);
  const codes = [...new Set(c.codes)];
  const dx = c.icd10.slice(0, 12);
  const pointers = Array.from({ length: Math.min(4, dx.length) }, (_, i) => i + 1);
  const modifiers = c.modifiers.map((m) => m.toUpperCase());
  for (const code of codes) if (!/^[A-Z0-9]{5}$/.test(code)) stops.push(`code ${code} isn't a CPT or HCPCS code (${FIX_AT.bill})`);
  for (const m of modifiers) if (!/^[A-Z0-9]{2}$/.test(m)) stops.push(`modifier ${m} isn't two characters (${FIX_AT.bill})`);
  const lines = codes.map((code) => ({
    code,
    // B1 and B2 on the visit's own line only (2027); the rest on every line, as before.
    modifiers: lineModifiers(code, modifiers).slice(0, 4),
    units: unitsOf(units, code),
    chargeCents: c.chargeCents[code] ?? 0,
    diagnosisPointers: pointers,
  }));
  if (lines.some((l) => l.chargeCents === 0)) warnings.push("a line billed $0.00");
  if (lines.some((l) => !Number.isInteger(l.units) || l.units < 1)) stops.push(`a line without whole units (${FIX_AT.bill})`);

  // A claim the payer has processed (denied, then corrected) goes as a
  // replacement of it; without the payer's number for it, as a new claim.
  let frequency: "1" | "7" = "1";
  if (c.status === "denied") {
    if (c.priorPayerClaimNumber) frequency = "7";
    else warnings.push("refiled as a new claim, not a replacement: there's no payer claim number on file for the original");
  }

  if (stops.length > 0 || !c.payer || !ctx.payerId || !b.address || !c.patient.address || !c.patient.dob) {
    return { claim: null, stops, warnings };
  }
  const filing =
    ctx.payerId.claimFilingIndicator || FILING_INDICATOR_BY_PAYER_TYPE[c.payer.type] || "CI";
  const claim: Claim837 = {
    claimRef: c.claimRef,
    frequency,
    originalClaimNumber: frequency === "7" ? c.priorPayerClaimNumber : null,
    priorAuthNumber: c.priorAuthNumber ?? null,
    placeOfService: c.placeOfService!,
    dateOfService: c.dateOfService,
    diagnoses: dx,
    lines,
    billing: {
      name: b.name!,
      npi: b.npi!,
      ein: b.ein!,
      taxonomy: b.taxonomy,
      address: toX12Address(b.address),
      payTo: b.payTo ? toX12Address(b.payTo) : null,
    },
    referring: c.referring?.provider ?? null,
    rendering:
      c.rendering.npi.replace(/\D/g, "") === (b.npi ?? "").replace(/\D/g, "")
        ? null
        : { lastName: rendering.lastName, firstName: rendering.firstName, npi: c.rendering.npi, taxonomy: c.rendering.taxonomy },
    subscriber: {
      lastName: c.patient.lastName,
      firstName: c.patient.firstName,
      memberId: c.memberId,
      dob: c.patient.dob,
      sex: SEX(c.patient.sex),
      address: toX12Address(c.patient.address),
      groupNumber: c.groupNumber,
    },
    payer: { name: c.payer.name, id: ctx.payerId.externalPayerId, filingIndicator: filing },
  };
  return { claim, stops, warnings };
}

/** The file's name: Pallio's, the interchange number, the extension the clearinghouse takes. */
export function claimFileName(icn: number, extension: string): string {
  return `pallio-837p-${String(icn).padStart(9, "0")}${extension}`;
}
