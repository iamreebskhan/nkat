/**
 * The Claim ref: the short reference a payer's 835 can echo back (audit R10).
 *
 * An 835 names each claim by CLP01, which is whatever the biller typed as the
 * patient control number on the claim (CMS-1500 box 26, 837 CLM01). Pallio had
 * nothing short to put there: the PDF printed a 36-character UUID, and the 837
 * guide only guarantees that 20 characters of it come back. So no remittance
 * could ever be tied to a superbill, even once one was parsed.
 *
 * The ref is the first 12 hex characters of the superbill's id, uppercased.
 * It needs no column: every id that starts with those 48 bits lies in one
 * primary-key range, so matching is a range scan. 48 bits is far more than one
 * org's bills can collide on, and a collision is caught anyway (the service
 * sends a claim matching two bills to review).
 *
 * Pure and client-safe: the queue, the bill page and the PDF all print it.
 */

const HEX12 = /^[0-9A-F]{12}$/;
const HEX32 = /^[0-9A-F]{32}$/;

/** b2e303af-e2cb-4292-8d00-c35c07423a0d → "B2E303AFE2CB". */
export function claimRefFor(superbillId: string): string {
  return superbillId.replace(/-/g, "").slice(0, 12).toUpperCase();
}

/**
 * CLP01 as the payer echoed it, reduced to what a ref can contain. Payers and
 * clearinghouses re-case it and some keep a biller's spaces or dashes.
 */
export function normalizeClaimRef(clp01: string): string {
  return clp01.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * The superbill id range a ref names, for `id BETWEEN lo AND hi`. A 12-hex ref
 * is a prefix; a whole id (32 hex, dashes optional) names itself, lo = hi.
 * null for anything else — CLAIM-001, NOPE00000001 — so the caller falls back.
 */
export function claimRefBounds(ref: string): { lo: string; hi: string } | null {
  const n = normalizeClaimRef(ref);
  if (HEX32.test(n)) {
    const id = asUuid(n);
    return { lo: id, hi: id };
  }
  if (!HEX12.test(n)) return null;
  const h = n.toLowerCase();
  return {
    lo: `${h.slice(0, 8)}-${h.slice(8, 12)}-0000-0000-000000000000`,
    hi: `${h.slice(0, 8)}-${h.slice(8, 12)}-ffff-ffff-ffffffffffff`,
  };
}

function asUuid(hex32: string): string {
  const h = hex32.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
