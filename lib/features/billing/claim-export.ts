/**
 * Claims as claim lines for the billing software (0118; Level-1 doc:72; Mark
 * Q1 default: "a standard claim-line export (CSV) plus the superbill PDF, not
 * tied to any one product"). Pure, so the columns, the escaping and the hard
 * stops are one rule the service and the specs share.
 *
 * One row per service line, the claim's fields repeated on each: what the
 * CMS-1500 carries, by box. Modifiers are the bill's own, on every line, as
 * the bill and its PDF hold them.
 *
 * Hard stops (Mark Q5 default): a claim with no member ID, no diagnosis or no
 * CPT code does not leave. Everything else a claim could still lack is a
 * warning the export reports and does not stop.
 */
import type { ReferringResult } from "@/lib/features/billing/claim-referring";
import { formatCodes, normalizeUnits, unitsOf, type CodeUnits } from "@/lib/features/billing/code-units";

export const EXPORTABLE_STATUSES = ["ready_to_submit", "submitted", "denied"] as const;

export interface ExportAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export interface ClaimForExport {
  superbillId: string;
  visitId: string;
  claimRef: string;
  status: string;
  dateOfService: string;
  placeOfService: string;
  codes: string[];
  units: CodeUnits;
  modifiers: string[];
  icd10: string[];
  /** Per code: the line's charge in cents (units × fee or rate). */
  chargeCents: Record<string, number>;
  billedCents: number;
  expectedCents: number | null;
  patient: {
    lastName: string; firstName: string; dob: string; sex: string | null;
    address: ExportAddress | null;
  };
  payerName: string | null;
  memberId: string;
  groupNumber: string | null;
  secondary: { payerName: string | null; memberId: string | null } | null;
  rendering: { name: string; npi: string; taxonomy: string | null };
  billing: {
    name: string | null; npi: string | null; ein: string | null; taxonomy: string | null;
    address: ExportAddress | null; payTo: ExportAddress | null;
  };
  /** Box 17 (0123), resolved by claim-referring.ts; absent when the practice leaves it off. */
  referring?: ReferringResult;
  /** Box 23 (0124): the prior authorization on the chart that covers this claim. */
  priorAuthNumber?: string | null;
}

export const CLAIM_EXPORT_COLUMNS = [
  "claim_ref", "superbill_id", "visit_id", "line", "date_of_service", "place_of_service",
  "cpt_hcpcs", "modifier_1", "modifier_2", "modifier_3", "modifier_4", "units", "line_charge", "diagnosis_pointer",
  ...Array.from({ length: 12 }, (_, i) => `icd10_${i + 1}`),
  "patient_last_name", "patient_first_name", "patient_dob", "patient_sex",
  "patient_address_1", "patient_address_2", "patient_city", "patient_state", "patient_zip",
  "payer_name", "member_id", "group_number", "secondary_payer_name", "secondary_member_id",
  "rendering_provider_name", "rendering_npi", "rendering_taxonomy",
  "billing_provider_name", "billing_npi", "billing_ein", "billing_taxonomy",
  "billing_address_1", "billing_address_2", "billing_city", "billing_state", "billing_zip",
  "pay_to_address_1", "pay_to_address_2", "pay_to_city", "pay_to_state", "pay_to_zip",
  "claim_total_charge", "claim_expected_amount",
  // Last, so a template built on the columns above still lines up (0123).
  "referring_provider_name", "referring_npi", "prior_auth_number",
] as const;

/** Why a claim may not leave (Mark Q5 default): the three a payer rejects outright. */
export function claimHardStops(c: Pick<ClaimForExport, "memberId" | "icd10" | "codes">): string[] {
  return [
    !c.memberId.trim() && "no member ID",
    c.icd10.length === 0 && "no diagnosis",
    c.codes.length === 0 && "no CPT code",
  ].filter((x): x is string => Boolean(x));
}

/** What the claim lacks that the billing software will want; reported, never stopped. */
export function claimExportWarnings(c: ClaimForExport): string[] {
  const out: string[] = [];
  if (!c.rendering.npi) out.push("no rendering NPI");
  if (!c.billing.npi) out.push("no billing NPI");
  if (!c.billing.ein) out.push("no EIN");
  if (!c.billing.address) out.push("no billing address");
  if (!c.billing.taxonomy) out.push("no billing taxonomy");
  if (c.icd10.length > 12) out.push(`${c.icd10.length} diagnoses; a claim carries 12`);
  if (c.billedCents === 0) out.push("billed $0.00");
  if (!c.patient.address) out.push("no patient address");
  if (!c.patient.sex) out.push("no patient sex");
  if (c.referring?.warning) out.push(c.referring.warning);
  return out;
}

/**
 * The patient's sex as a claim carries it (CMS-1500 box 3; the 837P takes F, M
 * or U). The chart's X and "unknown" have no claim value of their own and go
 * as U. Nothing recorded stays empty, and is a warning above.
 */
export function claimSex(sex: string | null): string {
  if (sex === "M" || sex === "F") return sex;
  return sex ? "U" : "";
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** The claim's lines, in the columns above. */
export function claimRows(c: ClaimForExport): string[][] {
  const units = normalizeUnits(c.codes, c.units);
  const codes = [...new Set(c.codes)];
  const dx = c.icd10.slice(0, 12);
  const pointer = "ABCD".slice(0, Math.min(4, dx.length));
  const mods = c.modifiers.slice(0, 4);
  const a = (x: ExportAddress | null) => [x?.line1 ?? "", x?.line2 ?? "", x?.city ?? "", x?.state ?? "", x?.zip ?? ""];
  return codes.map((code, i) => [
    c.claimRef, c.superbillId, c.visitId, String(i + 1), c.dateOfService, c.placeOfService,
    code, mods[0] ?? "", mods[1] ?? "", mods[2] ?? "", mods[3] ?? "", String(unitsOf(units, code)),
    dollars(c.chargeCents[code] ?? 0), pointer,
    ...Array.from({ length: 12 }, (_, j) => dx[j] ?? ""),
    c.patient.lastName, c.patient.firstName, c.patient.dob, claimSex(c.patient.sex), ...a(c.patient.address),
    c.payerName ?? "", c.memberId, c.groupNumber ?? "", c.secondary?.payerName ?? "", c.secondary?.memberId ?? "",
    c.rendering.name, c.rendering.npi, c.rendering.taxonomy ?? "",
    c.billing.name ?? "", c.billing.npi ?? "", c.billing.ein ?? "", c.billing.taxonomy ?? "",
    ...a(c.billing.address), ...a(c.billing.payTo),
    dollars(c.billedCents), c.expectedCents === null ? "" : dollars(c.expectedCents),
    c.referring?.provider?.fullName ?? "", c.referring?.provider?.npi ?? "", c.priorAuthNumber ?? "",
  ]);
}

/**
 * One CSV cell: quoted when it holds a comma, quote or line break, and with a
 * leading formula character neutralised, so a value never runs as a formula in
 * the spreadsheet a biller opens it in.
 */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function claimsCsv(claims: ClaimForExport[]): { csv: string; lines: number } {
  const rows = claims.flatMap(claimRows);
  const csv = [CLAIM_EXPORT_COLUMNS as readonly string[], ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return { csv, lines: rows.length };
}

/** "99349, G0318 ×2", for messages. */
export const claimCodes = (c: Pick<ClaimForExport, "codes" | "units">) => formatCodes(c.codes, c.units);
