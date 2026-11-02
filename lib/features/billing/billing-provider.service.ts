/**
 * Who the practice's claims bill as (0118; Level-1 doc:67): the billing
 * provider's legal name and NPI, EIN, taxonomy, billing address and, when
 * payment goes elsewhere, the pay-to address. CMS-1500 boxes 25, 33 and 33a/b;
 * 837P loops 2010AA and 2010AB.
 *
 * The NPI is the org NPI onboarding already records (onboarding_status.npi,
 * 0037), read and written here so there is one of it. The rest is
 * org_billing_provider. A bill names the billing NPI when drafted; the claim
 * export reads the rest at export, so a correction here reaches every claim
 * exported after it.
 */
import { z } from "zod";

import { withOrgContext } from "@/lib/db";
import { changedFieldNames, writeAudit } from "@/lib/features/audit/audit-write";
import { isValidNpi } from "@/lib/features/team/clinician";

import { NO_REFERRING, claimReferring, type ReferringResult } from "./claim-referring";

const Address = z
  .object({
    line1: z.string().trim().min(1, "Street address").max(120),
    line2: z.string().trim().max(120).optional(),
    city: z.string().trim().min(1, "City").max(80),
    state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Two-letter state"),
    zip: z
      .string()
      .trim()
      .transform((z) => z.replace(/-/g, ""))
      .pipe(z.string().regex(/^[0-9]{5}([0-9]{4})?$/, "ZIP: 5 or 9 digits")),
  })
  .strict();
export type BillingAddress = z.infer<typeof Address>;

/** A PO box cannot be the billing provider's address on an 837P. */
const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;

export const BillingProviderSchema = z
  .object({
    legalName: z.string().trim().min(1, "The name claims bill under").max(120),
    npi: z
      .string()
      .trim()
      .regex(/^[0-9]{10}$/, "NPI: 10 digits")
      .refine(isValidNpi, "That NPI fails its check digit — check it against NPPES."),
    ein: z
      .string()
      .trim()
      .transform((e) => e.replace(/-/g, ""))
      .pipe(z.string().regex(/^[0-9]{9}$/, "EIN: 9 digits, as XX-XXXXXXX"))
      .nullable(),
    taxonomyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{3}[0-9A-Z]{6}X$/, "Taxonomy: 10 characters ending in X, e.g. 207RH0002X")
      .nullable(),
    address: Address.refine((a) => !PO_BOX.test(a.line1), "The billing address must be a street address, not a PO box.").nullable(),
    payTo: Address.nullable(),
    /** Name the patient's referring physician on claims (box 17, 0123). Left out, it stays as it is. */
    claimReferringProvider: z.boolean().optional(),
  })
  .strict();
export type BillingProviderInput = z.infer<typeof BillingProviderSchema>;

export interface BillingProviderView {
  legalName: string | null;
  npi: string | null;
  ein: string | null;
  taxonomyCode: string | null;
  address: BillingAddress | null;
  payTo: BillingAddress | null;
  /** Claims name the patient's referring physician (box 17, 0123). */
  claimReferringProvider: boolean;
  /** What a claim still needs from here, by name. */
  missing: string[];
  updatedAt: string | null;
}

interface Row {
  legal_name: string | null;
  npi: string | null;
  ein: string | null;
  taxonomy_code: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  pay_to_address_line_1: string | null;
  pay_to_address_line_2: string | null;
  pay_to_city: string | null;
  pay_to_state: string | null;
  pay_to_zip: string | null;
  claim_referring_provider: boolean | null;
  updated_at: Date | null;
}

const addressOf = (l1: string | null, l2: string | null, city: string | null, state: string | null, zip: string | null) =>
  l1 && city && state && zip ? { line1: l1, ...(l2 ? { line2: l2 } : {}), city, state, zip } : null;

/** What a claim needs from the billing provider that is not on file. */
export function billingProviderMissing(v: Pick<BillingProviderView, "legalName" | "npi" | "ein" | "taxonomyCode" | "address">): string[] {
  return [
    !v.legalName && "legal name",
    !v.npi && "NPI",
    !v.ein && "EIN",
    !v.taxonomyCode && "taxonomy",
    !v.address && "billing address",
  ].filter((x): x is string => Boolean(x));
}

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** The billing provider, in the transaction the caller holds (the claim export reads it so). */
export async function readBillingProvider(tx: Tx, orgId: string): Promise<BillingProviderView> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT b.legal_name, ob.npi, b.ein, b.taxonomy_code,
           b.address_line_1, b.address_line_2, b.city, b.state, b.zip,
           b.pay_to_address_line_1, b.pay_to_address_line_2, b.pay_to_city, b.pay_to_state, b.pay_to_zip,
           b.claim_referring_provider, b.updated_at
      FROM org o
      LEFT JOIN org_billing_provider b ON b.org_id = o.id
      LEFT JOIN onboarding_status ob ON ob.org_id = o.id
     WHERE o.id = ${orgId}::uuid
  `;
  const r = rows[0];
  const v = {
    legalName: r?.legal_name ?? null,
    npi: r?.npi?.trim() || null,
    ein: r?.ein ?? null,
    taxonomyCode: r?.taxonomy_code ?? null,
    address: r ? addressOf(r.address_line_1, r.address_line_2, r.city, r.state, r.zip) : null,
    payTo: r ? addressOf(r.pay_to_address_line_1, r.pay_to_address_line_2, r.pay_to_city, r.pay_to_state, r.pay_to_zip) : null,
    claimReferringProvider: r?.claim_referring_provider === true,
    updatedAt: r?.updated_at?.toISOString() ?? null,
  };
  return { ...v, missing: billingProviderMissing(v) };
}

export async function getBillingProvider(orgId: string): Promise<BillingProviderView> {
  return withOrgContext(orgId, (tx) => readBillingProvider(tx, orgId));
}

/**
 * What box 17 says for each of these patients' claims (0123), in the caller's
 * transaction. Every patient gets an answer: on, one with no referring link
 * gets the warning. Off, nothing is read.
 */
export async function readClaimReferring(
  tx: Tx,
  a: { orgId: string; on: boolean; patientIds: string[] },
): Promise<Map<string, ReferringResult>> {
  const out = new Map<string, ReferringResult>();
  if (!a.on) {
    for (const id of a.patientIds) out.set(id, NO_REFERRING);
    return out;
  }
  const links = await tx.$queryRaw<{ patient_id: string; full_name: string; npi: string | null }[]>`
    SELECT l.patient_id, ep.full_name, ep.npi
      FROM patient_external_provider l
      JOIN external_provider ep ON ep.id = l.external_provider_id AND ep.org_id = l.org_id
     WHERE l.org_id = ${a.orgId}::uuid AND l.role = 'referring' AND l.patient_id = ANY(${a.patientIds}::uuid[])
  `;
  const byPatient = new Map(links.map((l) => [l.patient_id, { fullName: l.full_name, npi: l.npi }]));
  for (const id of a.patientIds) out.set(id, claimReferring(true, byPatient.get(id)));
  return out;
}

export async function updateBillingProvider(args: {
  orgId: string; userId: string; payload: BillingProviderInput;
}): Promise<BillingProviderView> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const before = await readBillingProvider(tx, args.orgId);
    const a = p.address;
    const t = p.payTo;
    await tx.$executeRaw`
      INSERT INTO org_billing_provider (
        org_id, legal_name, ein, taxonomy_code,
        address_line_1, address_line_2, city, state, zip,
        pay_to_address_line_1, pay_to_address_line_2, pay_to_city, pay_to_state, pay_to_zip,
        claim_referring_provider, updated_by_user_id, updated_at
      ) VALUES (
        ${args.orgId}::uuid, ${p.legalName}, ${p.ein}, ${p.taxonomyCode},
        ${a?.line1 ?? null}, ${a?.line2 || null}, ${a?.city ?? null}, ${a?.state ?? null}, ${a?.zip ?? null},
        ${t?.line1 ?? null}, ${t?.line2 || null}, ${t?.city ?? null}, ${t?.state ?? null}, ${t?.zip ?? null},
        ${p.claimReferringProvider ?? before.claimReferringProvider}, ${args.userId}::uuid, now()
      )
      ON CONFLICT (org_id) DO UPDATE SET
        legal_name = EXCLUDED.legal_name, ein = EXCLUDED.ein, taxonomy_code = EXCLUDED.taxonomy_code,
        address_line_1 = EXCLUDED.address_line_1, address_line_2 = EXCLUDED.address_line_2,
        city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
        pay_to_address_line_1 = EXCLUDED.pay_to_address_line_1, pay_to_address_line_2 = EXCLUDED.pay_to_address_line_2,
        pay_to_city = EXCLUDED.pay_to_city, pay_to_state = EXCLUDED.pay_to_state, pay_to_zip = EXCLUDED.pay_to_zip,
        claim_referring_provider = EXCLUDED.claim_referring_provider,
        updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
    `;
    // The org NPI is onboarding's: one of it, kept there.
    await tx.$executeRaw`
      INSERT INTO onboarding_status (org_id, npi) VALUES (${args.orgId}::uuid, ${p.npi})
      ON CONFLICT (org_id) DO UPDATE SET npi = EXCLUDED.npi, updated_at = now()
    `;
    const flat = (x: BillingAddress | null) => (x ? [x.line1, x.line2 || "", x.city, x.state, x.zip].join("|") : null);
    const changed = (was: unknown, now: unknown) => ((was ?? null) === (now ?? null) ? undefined : true);
    const fields = changedFieldNames({
      legalName: changed(before.legalName, p.legalName),
      npi: changed(before.npi, p.npi),
      ein: changed(before.ein, p.ein),
      taxonomyCode: changed(before.taxonomyCode, p.taxonomyCode),
      address: changed(flat(before.address), flat(p.address)),
      payTo: changed(flat(before.payTo), flat(p.payTo)),
      claimReferringProvider: changed(before.claimReferringProvider, p.claimReferringProvider ?? before.claimReferringProvider),
    });
    if (fields.length > 0) {
      // Field names only: never the EIN or an address.
      await writeAudit(tx, {
        orgId: args.orgId, userId: args.userId, action: "settings_update", targetType: "billing_provider",
        targetId: null, payload: { change: before.updatedAt ? "edit" : "create", fields },
      });
    }
    return readBillingProvider(tx, args.orgId);
  });
}
