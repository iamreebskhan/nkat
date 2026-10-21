/**
 * Remittance (ERA/835) ingestion — audit R10.
 *
 * Payer truth never entered Pallio. Every paid amount was typed, or copied
 * from "billed" by one click, and every denial was the org's own assertion, so
 * "Collected", "Outstanding" and every denial count were the org's word on
 * both legs of the claim. This posts the payer's own file. The org downloads
 * the 835 from its clearinghouse or the payer's portal and uploads it; Pallio
 * fetches nothing (R35).
 *
 * THE FLOW. Parse (the legacy backend's parser, ported verbatim) → record the
 * file once per org by content hash → post each claim in its OWN transaction,
 * one after another → one audit row with counts.
 *
 * One transaction per claim, sequential, never parallel. withOrgContext runs
 * prisma.$transaction with Prisma's 5 s interactive-transaction timeout, which
 * a whole file in one transaction would blow through, and parallel
 * transactions exhaust the pool (the claims screen found that out). It also
 * means one bad claim rolls back alone while the rest of the file posts.
 *
 * EVERY STATUS MOVE GOES THROUGH markStatusTx, the function a person's click
 * uses, so the transition map (R26), the rendering-NPI check (R40), the trail
 * and the audit row (R24) all hold. The payer documentation gate (R19) reads
 * the claim but does not block: it exists to stop a claim going out, and the
 * payer has already processed this one, so a gap is recorded on the trail and
 * the audit row instead.
 *
 * NOT EVERY DENIAL IS NEWS. A file dated on or before the bill's latest refile
 * answers the claim as first filed and goes to review (staleAgainstRefile), and
 * a denial already open on the bill for the same code and reason, under any
 * decision, is not opened a second time (recordDenials).
 *
 * IDEMPOTENT. The same file uploaded again posts nothing twice: a claim with a
 * paid, partially paid or denied row from this file is skipped, and only the
 * unmatched and held-for-review claims are retried (their rows are replaced).
 *
 * NO PHI FROM THE FILE. The parser never keeps the patient's name from NM1*QC,
 * and the member id it does keep is used only as a match key in one SELECT.
 * era_835_record rows carry codes, amounts, dates, CLP01/CLP07 and what the
 * posting did; patient_external_id and raw_segment are written NULL, in so
 * many words, below.
 */
import { createHash } from "node:crypto";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { lookupCarc } from "@/lib/features/denials/denial-pure";
import {
  markStatusTx,
  type StatusSource,
  type SuperbillStatus,
} from "@/lib/features/superbills/superbill.service";
import { reportError } from "@/lib/observability/sentry";

import { claimRefBounds, claimRefFor } from "./claim-ref";
import { parseEra835 } from "./era835-parser";
import type { Era835Claim } from "./era835-types";
import {
  classifyClaim,
  planPosting,
  staleAgainstRefile,
  type ClaimClassification,
} from "./remittance-pure";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

export type Posting = "paid" | "partially_paid" | "denied" | "unmatched" | "needs_review";

/** Postings that moved a status or money: never posted twice from one file. */
const POSTED: ReadonlySet<string> = new Set(["paid", "partially_paid", "denied"]);

/** An ST segment naming the 835 transaction set, whatever the element separator. */
const ST_835 = /(?:^|[^A-Za-z0-9])ST([^A-Za-z0-9\s])835\1/;

export interface RemittanceCounts {
  claims: number;
  paid: number;
  partiallyPaid: number;
  denied: number;
  unmatched: number;
  needsReview: number;
  errors: number;
  /** Claims an earlier upload of this same file already posted. */
  alreadyPosted: number;
  /** What this upload posted as paid, in cents. */
  paidCents: number;
}

export interface RemittanceReport {
  fileId: string;
  alreadyUploaded: boolean;
  counts: RemittanceCounts;
  unmatched: { claimId: string; dos: string | null; billedCents: number; paidCents: number }[];
  needsReview: { claimId: string; note: string }[];
  errors: { claimId: string; message: string }[];
}

interface MatchedBill {
  id: string;
  status: SuperbillStatus;
  provider_npi: string | null;
  payer_id: string | null;
  visit_id: string | null;
  cpt_codes: string[] | null;
  dos: string;
}

interface ClaimContext {
  orgId: string;
  userId: string;
  fileId: string;
  filename: string;
  traceNumber: string | null;
  /** BPR16, the date the payer issued the file; null when it gives none. */
  paymentDate: string | null;
  /** 1-based position of the claim in the file. */
  seq: number;
  claim: Era835Claim;
  source: StatusSource;
}

type ClaimResult =
  | { posting: "already_posted" }
  | { posting: Posting; note: string; paidCents: number };

const cents = (dollars: number) => Math.round(dollars * 100);
const dateOnly = (d: Date | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const trn = (trace: string | null) => (trace ? ` ${trace}` : "");

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Every date of service the claim names, at claim level and on its lines. */
function claimDates(claim: Era835Claim): string[] {
  return uniq(
    [claim.service_dos, ...claim.service_lines.map((l) => l.service_dos)]
      .map(dateOnly)
      .filter((d): d is string => d !== null),
  );
}

export async function ingestRemittance(args: {
  orgId: string;
  userId: string;
  filename: string;
  text: string;
}): Promise<RemittanceReport> {
  if (!ST_835.test(args.text)) {
    throw new ValidationError(
      "This is not an 835 remittance: it has no ST*835 segment. Upload the ERA file from your clearinghouse or the payer's portal.",
    );
  }
  const parsed = parseEra835(args.text);
  if (parsed.claims.length === 0) {
    throw new ValidationError("This 835 carries no claims (no CLP segment), so there is nothing to post.");
  }

  const sha256 = createHash("sha256").update(args.text).digest("hex");
  const filename = args.filename.trim().slice(0, 200) || "remittance.835";
  const traceNumber = parsed.header.trace_number?.trim().slice(0, 80) || null;
  const payerName = parsed.header.payer_name?.trim().slice(0, 200) || null;
  const totalPaidCents =
    parsed.header.total_paid !== undefined ? cents(parsed.header.total_paid) : null;

  // The file, once per org. The same text uploaded again finds the first row,
  // and the claims below skip whatever it already posted.
  const { fileId, alreadyUploaded } = await withOrgContext(args.orgId, async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO remittance_file (
        org_id, sha256, filename, payer_name, trace_number, payment_date,
        total_paid_cents, claim_count, uploaded_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${sha256}, ${filename}, ${payerName}, ${traceNumber},
        ${dateOnly(parsed.header.payment_date)}::date, ${totalPaidCents},
        ${parsed.claims.length}, ${args.userId}::uuid
      )
      ON CONFLICT (org_id, sha256) DO NOTHING
      RETURNING id
    `;
    if (inserted[0]) return { fileId: inserted[0].id, alreadyUploaded: false };
    const existing = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM remittance_file
       WHERE org_id = ${args.orgId}::uuid AND sha256 = ${sha256}
       LIMIT 1
    `;
    if (!existing[0]) throw new Error("remittance_file: sha256 conflict but no row found.");
    return { fileId: existing[0].id, alreadyUploaded: true };
  });

  const source: StatusSource = { kind: "remittance", remittanceFileId: fileId, traceNumber };
  const report: RemittanceReport = {
    fileId,
    alreadyUploaded,
    counts: {
      claims: parsed.claims.length,
      paid: 0,
      partiallyPaid: 0,
      denied: 0,
      unmatched: 0,
      needsReview: 0,
      errors: 0,
      alreadyPosted: 0,
      paidCents: 0,
    },
    unmatched: [],
    needsReview: [],
    errors: [],
  };

  // One claim per transaction, strictly one after another (see the header).
  for (const [i, claim] of parsed.claims.entries()) {
    const ctx: ClaimContext = {
      orgId: args.orgId,
      userId: args.userId,
      fileId,
      filename,
      traceNumber,
      paymentDate: dateOnly(parsed.header.payment_date),
      seq: i + 1,
      claim,
      source,
    };
    try {
      const result = await withOrgContext(args.orgId, (tx) => postClaim(tx, ctx));
      tally(report, claim, result);
    } catch (err) {
      // The claim rolled back alone. A typed refusal says why; anything else
      // may be a driver message, so it is reported and not echoed.
      const typed = err instanceof ValidationError || err instanceof NotFoundError;
      if (!typed) reportError(err, { source: "ingestRemittance" });
      const message = typed
        ? err.message
        : "This claim could not be posted. Upload the file again to retry it.";
      report.counts.errors += 1;
      report.errors.push({ claimId: claim.claim_id, message });
      // Keep it on the file as held for review, so the file's lines list it
      // and the next upload of the same file retries it. Best effort.
      await withOrgContext(args.orgId, async (tx) => {
        await tx.$executeRaw`
          DELETE FROM era_835_record
           WHERE remittance_file_id = ${fileId}::uuid AND claim_seq = ${ctx.seq}
             AND posting IN ('unmatched', 'needs_review')
        `;
        await insertLines(tx, ctx, { posting: "needs_review", note: message, bill: null });
      }).catch(() => undefined);
    }
  }

  // One audit row for the upload. Counts only (audit-write.ts): no claim id,
  // no per-patient amount, nothing from NM1.
  await withOrgContext(args.orgId, async (tx) => {
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "remittance_post",
      targetType: "remittance",
      targetId: fileId,
      payload: {
        claims: report.counts.claims,
        paid: report.counts.paid,
        partiallyPaid: report.counts.partiallyPaid,
        denied: report.counts.denied,
        unmatched: report.counts.unmatched,
        needsReview: report.counts.needsReview,
        errors: report.counts.errors,
        alreadyPosted: report.counts.alreadyPosted,
        totalPaidCents: report.counts.paidCents,
        alreadyUploaded,
      },
    });
  });

  return report;
}

function tally(report: RemittanceReport, claim: Era835Claim, r: ClaimResult): void {
  const c = report.counts;
  switch (r.posting) {
    case "already_posted":
      c.alreadyPosted += 1;
      return;
    case "paid":
      c.paid += 1;
      c.paidCents += r.paidCents;
      return;
    case "partially_paid":
      c.partiallyPaid += 1;
      c.paidCents += r.paidCents;
      return;
    case "denied":
      c.denied += 1;
      return;
    case "unmatched":
      c.unmatched += 1;
      report.unmatched.push({
        claimId: claim.claim_id,
        dos: claimDates(claim)[0] ?? null,
        billedCents: cents(claim.billed_amount),
        paidCents: cents(claim.paid_amount),
      });
      return;
    case "needs_review":
      c.needsReview += 1;
      report.needsReview.push({ claimId: claim.claim_id, note: r.note });
  }
}

async function postClaim(tx: Tx, c: ClaimContext): Promise<ClaimResult> {
  const prior = await tx.$queryRaw<{ posting: string }[]>`
    SELECT posting FROM era_835_record
     WHERE remittance_file_id = ${c.fileId}::uuid AND claim_seq = ${c.seq}
     FOR UPDATE
  `;
  if (prior.some((p) => POSTED.has(p.posting))) return { posting: "already_posted" };
  // Unmatched or held for review last time: this attempt replaces those rows.
  if (prior.length > 0) {
    await tx.$executeRaw`
      DELETE FROM era_835_record
       WHERE remittance_file_id = ${c.fileId}::uuid AND claim_seq = ${c.seq}
    `;
  }

  const verdict = classifyClaim(c.claim);
  const match = await findSuperbill(tx, c.claim);
  if (match.kind === "none") {
    return hold(
      tx,
      c,
      "unmatched",
      claimRefBounds(c.claim.claim_id)
        ? "No bill in Pallio carries this Claim ref."
        : "This claim carries no Pallio Claim ref, and no bill matched it by member, date of service and code.",
      null,
      verdict,
    );
  }
  if (match.kind === "ambiguous") {
    return hold(tx, c, "needs_review", "More than one bill in Pallio matches this claim. Post it by hand.", null, verdict);
  }

  const bill = match.bill;
  const dates = claimDates(c.claim);
  if (dates.length > 0 && !dates.includes(bill.dos)) {
    // A mistyped ref must not post money to someone else's bill.
    return hold(
      tx,
      c,
      "needs_review",
      "The remittance's date of service is not this bill's. Check the Claim ref on the claim you submitted.",
      bill,
      verdict,
    );
  }
  if (verdict.outcome === "needs_review") return hold(tx, c, "needs_review", verdict.note, bill, verdict);

  const plan = planPosting(bill.status, verdict.outcome, (bill.provider_npi ?? "").trim() !== "");
  if ("needsReview" in plan) return hold(tx, c, "needs_review", plan.needsReview, bill, verdict);

  // A file older than the bill's latest refile is the payer's answer to the
  // claim as first filed (see staleAgainstRefile). Posted, a denial in it
  // would move a refiled bill back to denied and close the refile while the
  // corrected claim is still with the payer.
  const stale = staleAgainstRefile(c.paymentDate, await latestRefile(tx, bill.id));
  if (stale) return hold(tx, c, "needs_review", stale, bill, verdict);

  for (const to of plan.steps) {
    await markStatusTx(tx, {
      orgId: c.orgId,
      id: bill.id,
      to,
      actorUserId: c.userId,
      source: c.source,
      ...(to === "paid" || to === "partially_paid" ? { paidAmountCents: verdict.paidCents } : {}),
    });
  }
  const status = plan.steps[plan.steps.length - 1] ?? bill.status;

  // The settle has to be TOLD which lines this file denies: it could not tell
  // on its own, and closed the very line the payer re-denied on the same file.
  const denied = deniedEntries(bill, verdict);
  // The reason-fill goes FIRST, before the settle. Filled, the queue's UNCODED
  // placeholder carries a line this file denies, so the settle's one rule holds
  // it open with nothing to tell it so. Held back by a flag instead — every
  // UNCODED row on the bill, while the fill claims at most one and may refuse
  // that one — a placeholder the fill did not take was left open forever, where
  // the payment used to close it.
  const filledId = denied.length > 0 ? await fillPlaceholderReason(tx, bill, denied[0]!) : null;
  // Then settle, so a partial payment's own denied lines (recorded next) stay
  // open rather than being closed by that payment.
  if (verdict.outcome === "paid" || verdict.outcome === "partially_paid") {
    await settleOpenDenials(tx, c, bill, verdict, denied);
  }
  const onRecord = denied.length > 0 ? await recordDenials(tx, c, bill, denied, status, filledId) : 0;
  // Said on the file's line, so a biller who finds no new row on the denials
  // queue sees why.
  const note =
    onRecord > 0
      ? `${verdict.note}; ${onRecord === 1 ? "1 denial was" : `${onRecord} denials were`} already open in Pallio and not opened again`
      : verdict.note;

  await insertLines(tx, c, { posting: verdict.outcome, note, bill });
  return { posting: verdict.outcome, note, paidCents: verdict.paidCents };
}

/** Record the claim as unmatched or held for review, posting nothing. */
async function hold(
  tx: Tx,
  c: ClaimContext,
  posting: "unmatched" | "needs_review",
  note: string,
  bill: MatchedBill | null,
  verdict: ClaimClassification,
): Promise<ClaimResult> {
  await insertLines(tx, c, { posting, note, bill });
  return { posting, note, paidCents: verdict.paidCents };
}

/**
 * The bill a claim names, locked. By Claim ref (CLP01) when it is one, as an
 * id range; otherwise by member id + date of service + a code in common, for a
 * claim submitted without the ref. The member id is used only here, as a
 * query parameter, and is never written anywhere.
 */
async function findSuperbill(
  tx: Tx,
  claim: Era835Claim,
): Promise<{ kind: "none" } | { kind: "ambiguous" } | { kind: "one"; bill: MatchedBill }> {
  let rows: MatchedBill[] = [];
  const bounds = claimRefBounds(claim.claim_id);
  if (bounds) {
    rows = await tx.$queryRaw<MatchedBill[]>`
      SELECT id, status, provider_npi, payer_id, visit_id, cpt_codes,
             to_char(date_of_service, 'YYYY-MM-DD') AS dos
        FROM superbill
       WHERE id BETWEEN ${bounds.lo}::uuid AND ${bounds.hi}::uuid
       ORDER BY id
       LIMIT 2
       FOR UPDATE
    `;
  } else {
    const memberId = claim.patient_external_id?.trim() ?? "";
    const dos = claimDates(claim)[0] ?? null;
    const codes = uniq(claim.service_lines.map((l) => l.service_code).filter(Boolean));
    if (memberId && dos && codes.length > 0) {
      rows = await tx.$queryRaw<MatchedBill[]>`
        SELECT id, status, provider_npi, payer_id, visit_id, cpt_codes,
               to_char(date_of_service, 'YYYY-MM-DD') AS dos
          FROM superbill
         WHERE member_id_snapshot = ${memberId}
           AND member_id_snapshot <> ''
           AND date_of_service = ${dos}::date
           AND cpt_codes && ${codes}::text[]
           AND status <> 'voided'
         ORDER BY id
         LIMIT 2
         FOR UPDATE
      `;
    }
  }
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "ambiguous" };
  return { kind: "one", bill: rows[0]! };
}

/**
 * When the bill last went out again: the latest refile stamped on its
 * denials, or the latest 'resubmitted' entry on its trail, whichever is later.
 * Both, because the claims queue's Resubmitted moves the bill without touching
 * a denial, and a refile from the denials screen may be stamped earlier than
 * the day it was recorded. The later of the two holds more files for review,
 * never fewer.
 */
async function latestRefile(tx: Tx, billId: string): Promise<Date | null> {
  const rows = await tx.$queryRaw<{ at: Date | null }[]>`
    SELECT GREATEST(
      (SELECT max(d.refiled_at) FROM superbill_denial d WHERE d.superbill_id = ${billId}::uuid),
      (SELECT max(a.at) FROM superbill_activity a
        WHERE a.superbill_id = ${billId}::uuid AND a.kind = 'resubmitted')
    ) AS at
  `;
  return rows[0]?.at ?? null;
}

/**
 * One denied line of this file as the denial row it will occupy: the CPT and
 * the CARC, which are what decide WHICH row on the bill it is, under
 * superbill_denial_pending_unique_idx (superbill_id, cpt_code, carc_code).
 *
 * Worked out once and handed to both the settle and the recording, so the two
 * cannot disagree about which rows belong to this file's own denials. They did
 * disagree, and a payment closed the line the payer had re-denied on the same
 * remittance.
 */
interface DeniedEntry {
  cptCode: string;
  carcCode: string;
  rarcCode: string | null;
  groupCode: string | null;
  deniedAmountCents: number;
}

function deniedEntries(bill: MatchedBill, verdict: ClaimClassification): DeniedEntry[] {
  return verdict.deniedLines.map((line) => ({
    // A claim that carried no service line denies the bill's first code, and a
    // line the payer gave no reason for is UNCODED — the same word the queue's
    // one-click Record denial writes.
    cptCode: line.code ?? bill.cpt_codes?.[0] ?? "—",
    carcCode: line.carc ?? "UNCODED",
    rarcCode: line.rarc,
    groupCode: line.group,
    deniedAmountCents: line.amountCents,
  }));
}

/**
 * The claim is paid now, so the denials still open on it ended in that
 * payment — every one EXCEPT those on a LINE this same file denies, which the
 * payer has just said is unpaid. The decision stays as the biller recorded it.
 *
 * `denied` is what holds that exception up, and the reason the whole function
 * takes it. Closing every open row on the bill closed the line the payer
 * re-denied on this very remittance: recordDenials then found nothing open to
 * fill or count, its INSERT hit the pending-unique index (the settle leaves
 * decision alone, so the row still occupies it) and was swallowed by ON
 * CONFLICT DO NOTHING, and the payer's re-denial existed nowhere as open work
 * — its only row read "settled by the payment", on a bill the biller saw as
 * partially paid.
 *
 * THE LINE, NOT THE LINE AND ITS REASON CODE. Excluding the (CPT, CARC) pair
 * still closed the very line the payer denied whenever the reason differed: a
 * bill carrying CARC 97 open on 99215, settled by a file that denies 99215
 * under CARC 16 — and stamped "recovered $0.00", because $0.00 is exactly what
 * the payer paid on the line it denied. The payer's word is about the line. If
 * it denied the line, no denial on that line was answered by this payment,
 * whatever reason either side gives it. The UNCODED placeholder needs no rule
 * of its own for the same reason: the reason-fill has already run and left the
 * row it took on a line this file denies.
 *
 * outcome_amount_cents is the row's own, not the claim's CLP04 total. That
 * total went onto EVERY open denial, so two denials on one bill reported
 * $197.00 recovered against a single $98.50 payment, and the audit rows
 * repeated the figure. A row gets what the payer paid on ITS CPT, and only
 * when it is the one denial settling for that CPT: with two open on the same
 * line the split is the payer's and not ours to invent, so it stays NULL for a
 * person to record, as recordOutcome's own amount is.
 */
async function settleOpenDenials(
  tx: Tx,
  c: ClaimContext,
  bill: MatchedBill,
  verdict: ClaimClassification,
  denied: DeniedEntry[],
): Promise<void> {
  // The lines this file denies. { CPT: cents } — what the payer paid on each
  // line of this claim.
  const deniedCodes = uniq(denied.map((d) => d.cptCode));
  const paidByCode: Record<string, number> = {};
  for (const line of c.claim.service_lines) {
    if (!line.service_code) continue;
    paidByCode[line.service_code] = (paidByCode[line.service_code] ?? 0) + cents(line.paid_amount);
  }

  const settled = await tx.$queryRaw<{ id: string; outcome_amount_cents: bigint | number | null }[]>`
    WITH settling AS (
      SELECT d.id, d.cpt_code
        FROM superbill_denial d
       WHERE d.superbill_id = ${bill.id}::uuid
         AND d.outcome = 'pending'
         AND NOT (d.cpt_code = ANY(${deniedCodes}::text[]))
       FOR UPDATE
    ),
    recovered AS (
      SELECT s.id,
             CASE WHEN count(*) OVER (PARTITION BY s.cpt_code) = 1
                  THEN (${JSON.stringify(paidByCode)}::jsonb ->> s.cpt_code)::bigint
             END AS cents
        FROM settling s
    )
    UPDATE superbill_denial SET
      outcome = ${verdict.outcome},
      outcome_at = now(),
      outcome_amount_cents = r.cents,
      outcome_notes = ${`Per payer remittance${trn(c.traceNumber)}`},
      updated_at = now()
     FROM recovered r
     WHERE superbill_denial.id = r.id
    RETURNING superbill_denial.id, superbill_denial.outcome_amount_cents
  `;
  // Each is a denial outcome, audited as recordOutcome audits one (R24). The
  // amount is read back from the write, so the audit row cannot report more
  // than was stamped on the denial itself.
  for (const d of settled) {
    await writeAudit(tx, {
      orgId: c.orgId,
      userId: c.userId,
      action: "denial_outcome",
      targetType: "denial",
      targetId: d.id,
      payload: {
        outcome: verdict.outcome,
        visitId: bill.visit_id,
        amountCents: d.outcome_amount_cents === null ? null : Number(d.outcome_amount_cents),
        source: "remittance",
      },
    });
  }
}

/**
 * The payer's reason in words: the CARC's standard text, which is what an EOB
 * prints. A code the catalog does not know stays bare rather than being
 * stored as "Unknown CARC"; the denials screen explains it on sight.
 */
function carcText(carc: string): string | null {
  if (carc === "UNCODED") return null;
  const e = lookupCarc(carc);
  return e.defaultRecommendation === "unknown" ? null : e.text;
}

/**
 * The queue's one-click Record denial leaves an UNCODED row whose reason is to
 * be filled in later. If that denial was never refiled, this file is its
 * reason: fill it in rather than counting the same denial twice. Returns the
 * row it filled, or null — there was none to fill, or another row on the bill
 * already carries this reason and that row stands (the guard in the statement).
 *
 * WHY IT IS OUT HERE, and not inside recordDenials with the rest of the
 * recording: it has to run before the settle. Filled, the row carries a line
 * this file denies and the settle holds it open by its own rule; refused, it is
 * an ordinary open denial and the payment settles it, as it did before any of
 * this. Told to hold every UNCODED row back instead, the settle could not tell
 * a row the fill would take from one it would refuse or never reach — the fill
 * claims ONE — and left those open forever, with zero denial outcomes recorded.
 *
 * It takes the placeholder already on the line this entry denies, and otherwise
 * the oldest: the queue writes the bill's FIRST code on a placeholder, which
 * need not be the line the payer went on to deny.
 */
async function fillPlaceholderReason(
  tx: Tx,
  bill: MatchedBill,
  entry: DeniedEntry,
): Promise<string | null> {
  const placeholder = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM superbill_denial
     WHERE superbill_id = ${bill.id}::uuid AND outcome = 'pending'
       AND carc_code = 'UNCODED' AND refiled_at IS NULL
     ORDER BY (cpt_code = ${entry.cptCode}) DESC, created_at
     LIMIT 1
     FOR UPDATE
  `;
  const id = placeholder[0]?.id;
  if (!id) return null;
  const { cptCode: code, carcCode: carc } = entry;
  // Guarded: a row already carrying this reason wins. decision 'pending' for
  // the pending-unique index, which allows one such row per (bill, code, CARC);
  // outcome 'pending' for a denial the team has decided but that is still open
  // (see the check before the insert in recordDenials).
  const filled = await tx.$queryRaw<{ id: string }[]>`
    UPDATE superbill_denial d SET
      cpt_code = ${code},
      carc_code = ${carc},
      rarc_code = ${entry.rarcCode},
      group_code = ${entry.groupCode},
      denied_amount_cents = ${entry.deniedAmountCents},
      denial_reason = ${carcText(carc)},
      source = 'remittance',
      updated_at = now()
     WHERE d.id = ${id}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM superbill_denial o
          WHERE o.superbill_id = d.superbill_id
            -- Never itself. When the file's line carries no reason code it is
            -- UNCODED on 99344 — and so is the placeholder, so without this
            -- the row matches its own guard, the fill refuses in silence, and
            -- the placeholder keeps no RARC, no group code and no denied
            -- amount while the posting counts it as already open.
            AND o.id <> d.id
            AND (o.decision = 'pending' OR o.outcome = 'pending')
            AND o.cpt_code = ${code} AND o.carc_code = ${carc}
       )
    RETURNING id
  `;
  return filled[0]?.id ?? null;
}

/**
 * Opens the file's denied lines on the bill. Returns how many of them were
 * already open there, and so were not opened again — the figure the posting
 * note quotes, so a biller who finds no new row on the denials queue is told
 * why instead of being left to guess.
 *
 * Takes the same DeniedEntry list the settle was given: on a partial payment
 * those rows are the ones the settle deliberately left open, and this is what
 * finds them again. `filledId` is the row the reason-fill already took for the
 * FIRST of those lines, if it took one.
 */
async function recordDenials(
  tx: Tx,
  c: ClaimContext,
  bill: MatchedBill,
  denied: DeniedEntry[],
  status: SuperbillStatus,
  filledId: string | null,
): Promise<number> {
  if (!filledId) {
    // Otherwise the claim was refiled and the resubmission denied. The
    // denials that were refiled end as secondary denials, and this one opens
    // with the payer's own reason.
    const closed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE superbill_denial SET
        outcome = 'secondary_denial',
        outcome_at = now(),
        outcome_notes = ${`Denied again per payer remittance${trn(c.traceNumber)}`},
        updated_at = now()
       WHERE superbill_id = ${bill.id}::uuid AND outcome = 'pending'
         AND refiled_at IS NOT NULL
      RETURNING id
    `;
    for (const d of closed) {
      await writeAudit(tx, {
        orgId: c.orgId,
        userId: c.userId,
        action: "denial_outcome",
        targetType: "denial",
        targetId: d.id,
        payload: { outcome: "secondary_denial", visitId: bill.visit_id, source: "remittance" },
      });
    }
  }

  const recorded: DeniedEntry[] = [];
  let onRecord = 0;
  /** Rows this file opened or filled, so a repeated line is not "on record". */
  const opened = new Set<string>();
  /** A denial re-opened by the INSERT's conflict, and the closure it cleared. */
  const reopened: { id: string; outcome: string; amountCents: number | null }[] = [];
  // The reason-fill took the first line before the settle ran, if it took one.
  if (filledId) {
    opened.add(filledId);
    recorded.push(denied[0]!);
  }
  for (const entry of denied.slice(filledId ? 1 : 0)) {
    const { cptCode: code, carcCode: carc } = entry;
    // The same denial already open on the bill, under ANY decision. The
    // pending-unique index covers decision = 'pending' only, so a denial the
    // team logged with its CARC and has since decided (an appeal, a refile not
    // yet sent), or the same ERA downloaded again under a new envelope, got a
    // second pending row, and /billing and the denials queue counted it twice.
    // The team's row stands as they recorded it.
    const open = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM superbill_denial
       WHERE superbill_id = ${bill.id}::uuid AND outcome = 'pending'
         AND cpt_code = ${code} AND carc_code = ${carc}
       ORDER BY created_at
       LIMIT 1
    `;
    if (open[0]) {
      if (!opened.has(open[0].id)) onRecord += 1;
      continue;
    }
    // superbill_denial_pending_unique_idx — (superbill_id, cpt_code,
    // carc_code) WHERE decision = 'pending' — is NAMED here, and the conflict
    // is taken rather than dropped. ON CONFLICT DO NOTHING, with no target,
    // returned no row and said nothing when it fired, so a denial that hit it
    // was lost in silence: no row, no trail entry, nothing on the posting note.
    // It fires on a row the check above cannot see, because that check only
    // finds denials still OPEN — a line Pallio had already closed (settled by
    // an earlier payment, or closed as a secondary denial) while the team never
    // decided it, and which the payer is now denying again. Production carries
    // such rows today.
    //
    // DO UPDATE always hands back the row it hit, so this write can never again
    // vanish unobserved. The row IS this line's denial: it takes the payer's
    // current reason and is open work again, dated now so the queue ages it
    // from this denial and not the first one, and the closure it used to carry
    // is cleared rather than left contradicting an open outcome.
    //
    // THE CLEARED CLOSURE IS SAID, and that is what the `prior` CTE is for. The
    // row need not be one Pallio closed: recordOutcome never touches `decision`,
    // so a denial a biller closed BY HAND — "paid, $98.50, per the EOB" — is
    // still decision 'pending', still occupies the index, and this is what hits
    // it. Wiping outcome_amount_cents with nothing in audit_log saying so is
    // worse than the swallowed INSERT it replaced: $98.50 of recorded recovery
    // gone, and no record that it ever existed. The CTEs share one snapshot, so
    // `prior` reads the row as it was before the DO UPDATE cleared it.
    const inserted = await tx.$queryRaw<
      { id: string; prior_outcome: string | null; prior_amount_cents: bigint | number | null }[]
    >`
      WITH prior AS (
        SELECT id, outcome, outcome_amount_cents
          FROM superbill_denial
         WHERE superbill_id = ${bill.id}::uuid
           AND cpt_code = ${code} AND carc_code = ${carc}
           AND decision = 'pending'
      ),
      upserted AS (
        INSERT INTO superbill_denial (
          org_id, superbill_id, payer_id, cpt_code, icd10_codes, modifiers,
          carc_code, rarc_code, group_code, denial_reason,
          denied_amount_cents, denied_at, source
        )
        SELECT ${c.orgId}::uuid, s.id, s.payer_id, ${code},
               COALESCE(s.icd10_codes, ARRAY[]::text[]),
               COALESCE(s.modifiers, ARRAY[]::text[]),
               ${carc}, ${entry.rarcCode}, ${entry.groupCode}, ${carcText(carc)},
               ${entry.deniedAmountCents}, now(), 'remittance'
          FROM superbill s
         WHERE s.id = ${bill.id}::uuid
        ON CONFLICT (superbill_id, cpt_code, carc_code) WHERE decision = 'pending'
        DO UPDATE SET
          rarc_code = EXCLUDED.rarc_code,
          group_code = EXCLUDED.group_code,
          denial_reason = EXCLUDED.denial_reason,
          denied_amount_cents = EXCLUDED.denied_amount_cents,
          denied_at = EXCLUDED.denied_at,
          source = EXCLUDED.source,
          outcome = 'pending',
          outcome_at = NULL,
          outcome_amount_cents = NULL,
          outcome_notes = NULL,
          updated_at = now()
        RETURNING id
      )
      SELECT u.id,
             p.outcome AS prior_outcome,
             p.outcome_amount_cents AS prior_amount_cents
        FROM upserted u
        LEFT JOIN prior p ON p.id = u.id
    `;
    const row = inserted[0];
    if (row) {
      opened.add(row.id);
      recorded.push(entry);
      // A fresh row has no prior, and an open one never reaches here (the check
      // above returns it). Anything else is a closure this re-open cleared.
      if (row.prior_outcome && row.prior_outcome !== "pending") {
        reopened.push({
          id: row.id,
          outcome: row.prior_outcome,
          amountCents: row.prior_amount_cents === null ? null : Number(row.prior_amount_cents),
        });
      }
    }
  }
  // One row per re-opened denial, naming what was cleared off it. The action is
  // denial_outcome because that is the column this changed (audit R24): the
  // denial's outcome went back to open, and the recovery recorded against it —
  // whoever recorded it — no longer stands.
  for (const r of reopened) {
    await writeAudit(tx, {
      orgId: c.orgId,
      userId: c.userId,
      action: "denial_outcome",
      targetType: "denial",
      targetId: r.id,
      payload: {
        outcome: "pending",
        visitId: bill.visit_id,
        amountCents: null,
        source: "remittance",
        clearedOutcome: r.outcome,
        clearedAmountCents: r.amountCents,
      },
    });
  }
  if (recorded.length === 0) return onRecord;

  // The denial is the pivot of the correction loop; the bill's trail names
  // the payer's reason and the file it came from. clock_timestamp(), not the
  // column's now() default: this shares a transaction with the status move
  // above it, and now() would stamp both with the transaction's start, so the
  // trail could list the reason before the denial.
  const reasons = recorded
    .map((r) => `CARC ${r.carcCode}${r.groupCode ? ` (${r.groupCode})` : ""} on ${r.cptCode}`)
    .join("; ");
  await tx.$executeRaw`
    INSERT INTO superbill_activity (
      org_id, superbill_id, actor_user_id, kind, to_status, summary, detail, at
    ) VALUES (
      ${c.orgId}::uuid, ${bill.id}::uuid, ${c.userId}::uuid, 'denial_logged', ${status},
      ${`Denial reason per payer remittance${trn(c.traceNumber)} — ${reasons}`},
      ${JSON.stringify({
        source: "remittance",
        remittanceFileId: c.fileId,
        lines: recorded,
        // So the claim history, and not only audit_log, carries that this
        // denial was open work again and what closure came off it.
        ...(reopened.length > 0 ? { reopened } : {}),
      })}::jsonb,
      clock_timestamp()
    )
  `;
  return onRecord;
}

/**
 * One era_835_record per service line (line_seq 0 for a claim that carried
 * none). Claim-level adjustments and remarks ride on the claim's first row.
 * client_id, patient_external_id and raw_segment are NULL by construction.
 */
async function insertLines(
  tx: Tx,
  c: ClaimContext,
  a: { posting: Posting; note: string; bill: MatchedBill | null },
): Promise<void> {
  const claim = c.claim;
  const lines = claim.service_lines.length > 0 ? claim.service_lines : [null];
  for (const [j, line] of lines.entries()) {
    const adjustments = [...(line?.adjustments ?? []), ...(j === 0 ? claim.adjustments : [])];
    const rarcs = uniq([...(line?.rarc_codes ?? []), ...(j === 0 ? claim.rarc_codes : [])]);
    const lead = adjustments.find((x) => x.group_code !== "PR") ?? adjustments[0] ?? null;
    const billed = line ? line.billed_amount : claim.billed_amount;
    const paid = line ? line.paid_amount : claim.paid_amount;
    const adjusted = adjustments.reduce((sum, x) => sum + x.amount, 0);
    await tx.$executeRaw`
      INSERT INTO era_835_record (
        org_id, remittance_file_id, claim_seq, line_seq,
        client_id, patient_external_id, raw_segment,
        payer_id, superbill_id, trace_number,
        claim_id, claim_status_code, payer_claim_control_number,
        service_dos, billed_amount, paid_amount, adjustment_amount,
        carc_codes, rarc_codes, group_code, service_codes, modifiers, units,
        posting, posting_note, source_file_uri
      ) VALUES (
        ${c.orgId}::uuid, ${c.fileId}::uuid, ${c.seq}, ${line ? j + 1 : 0},
        NULL, NULL, NULL,
        ${a.bill?.payer_id ?? null}::uuid, ${a.bill?.id ?? null}::uuid, ${c.traceNumber},
        ${claim.claim_id.slice(0, 80)}, ${claim.status_code || null},
        ${claim.payer_claim_control_number ?? null},
        ${dateOnly(line?.service_dos ?? claim.service_dos)}::date,
        ${billed.toFixed(2)}::numeric, ${paid.toFixed(2)}::numeric, ${adjusted.toFixed(2)}::numeric,
        ${uniq(adjustments.map((x) => x.reason_code))}::text[], ${rarcs}::text[],
        ${lead?.group_code ?? null},
        ${line?.service_code ? [line.service_code] : []}::text[], ${line?.modifiers ?? []}::text[],
        ${line ? Math.round(line.units) : null},
        ${a.posting}, ${a.note}, ${`upload://${c.filename}`}
      )
    `;
  }
}

export interface RemittanceFileView {
  id: string;
  filename: string;
  payerName: string | null;
  traceNumber: string | null;
  paymentDate: string | null;
  /** BPR02: the payment the file announces, for the whole file. */
  totalPaidCents: number | null;
  claimCount: number;
  uploadedAt: string;
  uploadedBy: string | null;
  /** Claims by what their posting did, read from the lines so a retry shows. */
  counts: { paid: number; partiallyPaid: number; denied: number; unmatched: number; needsReview: number };
}

export async function listRemittanceFiles(args: {
  orgId: string;
  limit?: number;
}): Promise<RemittanceFileView[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        filename: string;
        payer_name: string | null;
        trace_number: string | null;
        payment_date: string | null;
        total_paid_cents: bigint | number | null;
        claim_count: number;
        uploaded_at: Date;
        uploaded_by: string | null;
        paid: bigint | null;
        partially_paid: bigint | null;
        denied: bigint | null;
        unmatched: bigint | null;
        needs_review: bigint | null;
      }[]
    >`
      SELECT f.id, f.filename, f.payer_name, f.trace_number,
             to_char(f.payment_date, 'YYYY-MM-DD') AS payment_date,
             f.total_paid_cents, f.claim_count, f.uploaded_at,
             COALESCE(u.full_name, u.email) AS uploaded_by,
             c.paid, c.partially_paid, c.denied, c.unmatched, c.needs_review
        FROM remittance_file f
        LEFT JOIN app_user u ON u.id = f.uploaded_by_user_id
        LEFT JOIN LATERAL (
          SELECT COUNT(DISTINCT e.claim_seq) FILTER (WHERE e.posting = 'paid')           AS paid,
                 COUNT(DISTINCT e.claim_seq) FILTER (WHERE e.posting = 'partially_paid') AS partially_paid,
                 COUNT(DISTINCT e.claim_seq) FILTER (WHERE e.posting = 'denied')         AS denied,
                 COUNT(DISTINCT e.claim_seq) FILTER (WHERE e.posting = 'unmatched')      AS unmatched,
                 COUNT(DISTINCT e.claim_seq) FILTER (WHERE e.posting = 'needs_review')   AS needs_review
            FROM era_835_record e
           WHERE e.remittance_file_id = f.id
        ) c ON true
       ORDER BY f.uploaded_at DESC
       LIMIT ${limit}
    `;
    const n = (v: bigint | null) => Number(v ?? 0);
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      payerName: r.payer_name,
      traceNumber: r.trace_number,
      paymentDate: r.payment_date,
      totalPaidCents: r.total_paid_cents === null ? null : Number(r.total_paid_cents),
      claimCount: Number(r.claim_count),
      uploadedAt: r.uploaded_at.toISOString(),
      uploadedBy: r.uploaded_by,
      counts: {
        paid: n(r.paid),
        partiallyPaid: n(r.partially_paid),
        denied: n(r.denied),
        unmatched: n(r.unmatched),
        needsReview: n(r.needs_review),
      },
    }));
  });
}

export interface RemittanceLineView {
  claimSeq: number;
  lineSeq: number;
  /** CLP01 as the payer echoed it. */
  claimId: string | null;
  claimStatusCode: string | null;
  payerClaimControlNumber: string | null;
  dateOfService: string | null;
  billedCents: number | null;
  paidCents: number | null;
  carcCodes: string[];
  rarcCodes: string[];
  groupCode: string | null;
  serviceCodes: string[];
  modifiers: string[];
  posting: Posting;
  postingNote: string | null;
  superbillId: string | null;
  /** The matched bill's Claim ref; null when unmatched. */
  claimRef: string | null;
  /** Where the matched bill lives: /visits/{visitId}/superbill. */
  visitId: string | null;
}

export async function listRemittanceLines(args: {
  orgId: string;
  fileId: string;
}): Promise<RemittanceLineView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const file = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM remittance_file WHERE id = ${args.fileId}::uuid LIMIT 1
    `;
    if (!file[0]) throw new NotFoundError("Remittance file not found.");
    const rows = await tx.$queryRaw<
      {
        claim_seq: number;
        line_seq: number;
        claim_id: string | null;
        claim_status_code: string | null;
        payer_claim_control_number: string | null;
        dos: string | null;
        billed_cents: bigint | null;
        paid_cents: bigint | null;
        carc_codes: string[] | null;
        rarc_codes: string[] | null;
        group_code: string | null;
        service_codes: string[] | null;
        modifiers: string[] | null;
        posting: Posting;
        posting_note: string | null;
        superbill_id: string | null;
        visit_id: string | null;
      }[]
    >`
      SELECT e.claim_seq, e.line_seq, e.claim_id, e.claim_status_code,
             e.payer_claim_control_number,
             to_char(e.service_dos, 'YYYY-MM-DD') AS dos,
             ROUND(e.billed_amount * 100)::bigint AS billed_cents,
             ROUND(e.paid_amount * 100)::bigint AS paid_cents,
             e.carc_codes, e.rarc_codes, e.group_code, e.service_codes, e.modifiers,
             e.posting, e.posting_note, e.superbill_id, s.visit_id
        FROM era_835_record e
        LEFT JOIN superbill s ON s.id = e.superbill_id
       WHERE e.remittance_file_id = ${args.fileId}::uuid
       ORDER BY e.claim_seq, e.line_seq
    `;
    return rows.map((r) => ({
      claimSeq: Number(r.claim_seq),
      lineSeq: Number(r.line_seq),
      claimId: r.claim_id,
      claimStatusCode: r.claim_status_code,
      payerClaimControlNumber: r.payer_claim_control_number,
      dateOfService: r.dos,
      billedCents: r.billed_cents === null ? null : Number(r.billed_cents),
      paidCents: r.paid_cents === null ? null : Number(r.paid_cents),
      carcCodes: r.carc_codes ?? [],
      rarcCodes: r.rarc_codes ?? [],
      groupCode: r.group_code,
      serviceCodes: r.service_codes ?? [],
      modifiers: r.modifiers ?? [],
      posting: r.posting,
      postingNote: r.posting_note,
      superbillId: r.superbill_id,
      claimRef: r.superbill_id ? claimRefFor(r.superbill_id) : null,
      visitId: r.visit_id,
    }));
  });
}
