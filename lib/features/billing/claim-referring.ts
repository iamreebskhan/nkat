/**
 * The referring physician on a claim (0123): CMS-1500 box 17 (qualifier DN) and
 * 17b, 837P loop 2310A.
 *
 * Off until the practice turns it on (Settings → Billing provider): whether its
 * payers need it is the practice's to say, and box 17 filled with the wrong
 * provider is worse than box 17 left empty. On, a claim names the physician
 * linked on the chart as referring, and only with an NPI that passes its check
 * digit. Anything less leaves the box empty and says why, and never stops a
 * claim: most claims go out without it. Pure.
 */
import { splitPersonName } from "@/lib/features/clearinghouse/claim-837";
import { isValidNpi } from "@/lib/features/team/clinician";

export interface ClaimReferring {
  /** As the chart has it, for the bill and the export. */
  fullName: string;
  /** As the 837P's NM1 carries it. */
  lastName: string;
  firstName: string;
  npi: string;
}

export interface ReferringResult {
  provider: ClaimReferring | null;
  /** Why box 17 is empty on a claim the practice wants it on; said with the claim. */
  warning: string | null;
}

export const NO_REFERRING: ReferringResult = { provider: null, warning: null };

const FIX_AT = "patient's chart → Care team";

/** "Dr. Alan Brooks" → Alan / Brooks: a title is not a name. A credential goes with splitPersonName. */
export function referringName(fullName: string): { firstName: string; lastName: string } {
  return splitPersonName(fullName.trim().replace(/^(dr|doctor)\b\.?\s+/i, ""));
}

/** What a claim says in box 17, from the setting and the chart's referring link. */
export function claimReferring(on: boolean, link: { fullName: string; npi: string | null } | undefined): ReferringResult {
  if (!on) return NO_REFERRING;
  if (!link) return { provider: null, warning: `no referring physician on the chart, so box 17 is empty (${FIX_AT})` };
  const npi = (link.npi ?? "").replace(/\D/g, "");
  if (!npi) return { provider: null, warning: `no NPI for the referring physician, so box 17 is empty (${FIX_AT})` };
  if (!isValidNpi(npi)) {
    return { provider: null, warning: `the referring physician's NPI fails its check digit, so box 17 is empty (${FIX_AT})` };
  }
  const { firstName, lastName } = referringName(link.fullName);
  if (!lastName) return { provider: null, warning: `no name for the referring physician, so box 17 is empty (${FIX_AT})` };
  return { provider: { fullName: link.fullName.trim(), lastName, firstName, npi }, warning: null };
}
