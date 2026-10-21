/**
 * What a payer's 835 says happened to one claim, and what that means for the
 * superbill it matched (audit R10).
 *
 * Pure, no DB. remittance.service.ts applies the plan through markStatusTx, so
 * every step is a move of the same transition map a person's click goes
 * through; nothing here writes a status directly.
 *
 * Conservative on purpose. Anything that is not plainly a payment or a denial
 * (a reversal, a claim the payer paid nothing on without denying it, a bill
 * Pallio already settled) comes back as needs_review with a note, rather than
 * being guessed into the books. Re-uploading the file retries those claims.
 */
import type { SuperbillStatus } from "@/lib/features/superbills/superbill.service";

import type { Era835Adjustment, Era835Claim, Era835ServiceLine } from "./era835-types";

export type ClaimOutcome = "paid" | "partially_paid" | "denied" | "needs_review";

export interface DeniedLine {
  /** CPT/HCPCS the line billed; null on a claim that carried no service line. */
  code: string | null;
  /** The payer's reason code; null when the file gave none. */
  carc: string | null;
  rarc: string | null;
  group: Era835Adjustment["group_code"] | null;
  amountCents: number;
}

export interface ClaimClassification {
  outcome: ClaimOutcome;
  /** CLP04 in cents. */
  paidCents: number;
  deniedLines: DeniedLine[];
  /** One line on why. Stored as the posting note, so no PHI. */
  note: string;
}

const cents = (dollars: number) => Math.round(dollars * 100);
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * PR is patient responsibility (deductible, coinsurance): the payer processed
 * the claim and billed the patient. CO, OA and PI are the payer declining to
 * pay, which is what a denial is.
 */
const isPayerAdjustment = (a: Era835Adjustment) => a.group_code !== "PR";

function firstPayerAdjustment(...lists: Era835Adjustment[][]): Era835Adjustment | null {
  for (const list of lists) {
    const a = list.find(isPayerAdjustment);
    if (a) return a;
  }
  return null;
}

/**
 * The CARC is the first non-PR adjustment, from the line if it has one, else
 * from the claim — payers put it at either level.
 */
function deniedLine(claim: Era835Claim, line: Era835ServiceLine | null): DeniedLine {
  const adj = firstPayerAdjustment(line?.adjustments ?? [], claim.adjustments);
  const unpaid = line ? line.billed_amount - line.paid_amount : claim.billed_amount - claim.paid_amount;
  return {
    code: line?.service_code ? line.service_code : null,
    carc: adj?.reason_code ?? null,
    rarc: line?.rarc_codes[0] ?? claim.rarc_codes[0] ?? null,
    group: adj?.group_code ?? null,
    amountCents: Math.max(0, cents(unpaid)),
  };
}

const describeDenial = (lines: DeniedLine[]) => {
  const coded = lines.filter((l) => l.carc);
  return coded.length === 0
    ? "no reason code in the file"
    : [...new Set(coded.map((l) => `CARC ${l.carc}${l.group ? ` (${l.group})` : ""}`))].join(", ");
};

export function classifyClaim(claim: Era835Claim): ClaimClassification {
  const paidCents = cents(claim.paid_amount);
  const adjustments = [...claim.adjustments, ...claim.service_lines.flatMap((l) => l.adjustments)];
  const payerDeclined = adjustments.some(isPayerAdjustment);

  // A reversal takes back an earlier payment; which one, and what replaces it,
  // is a judgment the file does not make for us.
  if (claim.status_code === "22") {
    return {
      outcome: "needs_review",
      paidCents,
      deniedLines: [],
      note: "The payer reversed an earlier payment on this claim (CLP02 22). Post reversals by hand.",
    };
  }

  if (claim.status_code === "4" || (paidCents === 0 && payerDeclined)) {
    const deniedLines =
      claim.service_lines.length > 0
        ? claim.service_lines.map((l) => deniedLine(claim, l))
        : [deniedLine(claim, null)];
    return { outcome: "denied", paidCents, deniedLines, note: `Denied — ${describeDenial(deniedLines)}` };
  }

  if (paidCents < 0) {
    return {
      outcome: "needs_review",
      paidCents,
      deniedLines: [],
      note: "The payer took money back on this claim (a negative payment). Post recoupments by hand.",
    };
  }

  // Nothing paid, and nothing the payer declined: the whole amount went to the
  // patient (a deductible, say). The claim was processed, not denied.
  if (paidCents === 0) {
    return {
      outcome: "needs_review",
      paidCents,
      deniedLines: [],
      note:
        adjustments.length > 0
          ? "The payer paid nothing and assigned the whole amount to the patient (PR). That is not a denial; record it by hand."
          : "The payer paid nothing and gave no adjustment reason.",
    };
  }

  // Paid, but some line came back at $0 with the payer declining it.
  const declinedLines = claim.service_lines.filter(
    (l) => cents(l.paid_amount) === 0 && l.adjustments.some(isPayerAdjustment),
  );
  if (declinedLines.length > 0) {
    const deniedLines = declinedLines.map((l) => deniedLine(claim, l));
    return {
      outcome: "partially_paid",
      paidCents,
      deniedLines,
      note: `Paid ${money(paidCents)}; ${deniedLines.length} line${deniedLines.length === 1 ? "" : "s"} denied — ${describeDenial(deniedLines)}`,
    };
  }

  // Paid less than billed is still settled: a contractual adjustment (CO-45)
  // is the payer's allowed amount, not a denial.
  return {
    outcome: "paid",
    paidCents,
    deniedLines: [],
    note: `Paid ${money(paidCents)} of ${money(cents(claim.billed_amount))} billed`,
  };
}

/** The status steps to apply, or why the claim needs a person. */
export type PostingPlan = { steps: SuperbillStatus[] } | { needsReview: string };

/**
 * From the bill's status in Pallio to what the payer says happened.
 *
 * The payer processing a claim proves it was submitted, so a reviewed bill
 * (ready to submit) or a denied one steps through 'submitted' first. That step
 * keeps R40: a bill naming no rendering provider is not recorded as submitted,
 * so it goes to review instead.
 *
 * A DRAFT goes to review, not through ready_to_submit (audit R26). Stepping it
 * would write "Reviewed — ready to submit" on a bill nobody reviewed, and a
 * draft is still editable: its codes and amount may not be the claim the payer
 * adjudicated. A person reviews it on its bill page, records it as submitted,
 * and uploads the file again.
 *
 * A denied bill that is denied again gets no status step: the reason code is
 * filled in only.
 *
 * A partially paid bill goes to review on any further payment, not only a
 * second partial one. Posting 'paid' sets paid_amount_cents to this file's
 * CLP04, and a second 835 that carries only the balance would drop the first
 * payment from Collected.
 */
export function planPosting(
  status: SuperbillStatus,
  outcome: Exclude<ClaimOutcome, "needs_review">,
  hasNpi: boolean,
): PostingPlan {
  if (status === "paid") {
    return { needsReview: "This bill is already paid in Pallio, so the remittance was not posted to it. Compare them by hand." };
  }
  if (status === "voided") {
    return { needsReview: "This bill is voided in Pallio, so the remittance was not posted to it." };
  }
  if (status === "draft") {
    return {
      needsReview:
        "This bill is still a draft in Pallio: it was never reviewed or recorded as submitted. Review it on its bill page, record it as submitted, then upload this file again.",
    };
  }
  if (status === "partially_paid" && (outcome === "partially_paid" || outcome === "paid")) {
    return {
      needsReview: "A partial payment is already recorded on this bill. Add this one to it by hand.",
    };
  }
  if (status === "denied" && outcome === "denied") return { steps: [] };

  const steps: SuperbillStatus[] =
    status === "ready_to_submit" || status === "denied" ? ["submitted", outcome] : [outcome];
  if (steps[0] === "submitted" && !hasNpi) {
    return {
      needsReview:
        "This bill has no rendering-provider NPI, so Pallio will not record it as submitted. Record the clinician's NPI on the Team page, then upload this file again.",
    };
  }
  return { steps };
}

/**
 * Whether this file is older than the bill's latest refile.
 *
 * A denial the team recorded and then refiled leaves the bill submitted while
 * the corrected claim is with the payer. The ERA for the ORIGINAL denial can
 * still arrive after that: a backlog upload, or a file that lands days after
 * the portal showed the status. Posted as a new adjudication, it moved the
 * bill back to denied, closed the refile as a secondary denial and opened a
 * new denial, so a biller filed a duplicate.
 *
 * BPR16 is the date the payer issued the remittance. No payer adjudicates a
 * refile on the day it is sent, so a file dated on or before the latest refile
 * answers the claim as first filed, and it goes to a person. The refile's date
 * is taken in UTC, which for a US org puts an evening refile on the next day,
 * so the boundary day leans towards review. A file with no BPR16 on a refiled
 * bill cannot be placed on either side of the refile, so it goes to review too.
 *
 * Returns the posting note, or null when the file is newer than every refile.
 */
export function staleAgainstRefile(paymentDate: string | null, lastRefiledAt: Date | null): string | null {
  if (!lastRefiledAt) return null;
  const refiled = lastRefiledAt.toISOString().slice(0, 10);
  if (!paymentDate) {
    return `This claim was refiled on ${refiled} and this remittance carries no payment date (BPR16), so Pallio cannot tell whether it answers the claim as first filed or the corrected one. Compare it with the claim history and post it by hand.`;
  }
  if (paymentDate > refiled) return null;
  return `This remittance is dated ${paymentDate}, on or before this claim was refiled (${refiled}), so it answers the claim as first filed, not the corrected one still with the payer. Compare it with the claim history and post it by hand if it still applies.`;
}
