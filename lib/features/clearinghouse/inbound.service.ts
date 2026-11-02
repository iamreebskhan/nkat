/**
 * What comes back from a clearinghouse (0120), read the same way whether the
 * SFTP poll fetched it or a person uploaded it.
 *
 *   999 / TA1     answer the file Pallio built, by its group (AK102 = GS06)
 *                 and interchange (TA101 = ISA13) control numbers; a rejected
 *                 transaction set rejects its one claim (one claim per set).
 *   277CA         answers each claim by its patient control number (CLM01,
 *                 the Claim ref): accepted (A1/A2), or rejected (A3/A6/A7/A8,
 *                 or action U) before the payer processed it.
 *   277           a later status (pending, finalized): recorded, never moves
 *                 a claim — the 835 is the payer's word on money.
 *   835           posted by the remittance service, as an upload is.
 *   Availity's    "-FAILED" notices reject the file named; "-success" ones
 *   notices       and its own reports are recorded and change nothing.
 *
 * A rejection moves a submitted claim back to ready to submit (the only way
 * back, markStatusTx), with the reason on its history; an acceptance of a
 * claim the practice uploaded itself (still ready to submit in Pallio)
 * records it submitted. Every move goes through markStatusTx in its own
 * transaction, one claim after another, as the 835 posting does.
 *
 * NOTHING FROM THE FILE IS KEPT BUT WHAT IT SAID: the text is not stored, the
 * file row holds counts and control numbers, and the claim rows hold codes,
 * the payer's number for the claim and the payer's own message.
 */
import { createHash } from "node:crypto";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { claimRefBounds, claimRefFor } from "@/lib/features/remittances/claim-ref";
import { ingestRemittance } from "@/lib/features/remittances/remittance.service";
import { markStatusTx, type SuperbillStatus } from "@/lib/features/superbills/superbill.service";
import { reportError } from "@/lib/observability/sentry";

import { VENDOR_PROFILES, type ClearinghouseVendor } from "./vendors";
import { claimState277, isRejection, parse277, type ClaimStatus277 } from "./x12/x12-277";
import { groupAckState, parse999, parseTa1, setAckState, type AckSegmentError } from "./x12/x12-ack";
import { classifyClearinghouseFile, type ClearinghouseFileKind } from "./x12/x12-classify";
import {
  ACK_STATUSES,
  ackErrorNextStep,
  describeAckError,
  describeStatus,
  NEXT_STEPS,
  plainStatus,
  rejectionNextStep,
  TA1_NOTES,
} from "./x12/x12-codes";
import { readX12 } from "./x12/x12-read";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

export interface FileReport {
  fileId: string;
  kind: ClearinghouseFileKind;
  alreadyRead: boolean;
  outcome: "applied" | "nothing_to_apply" | "unmatched" | "failed";
  /** One line a person reads: what the file said and what Pallio did. */
  note: string;
  claimsUpdated: number;
  /** Of claimsUpdated, what the file said about them (the rest had another status). */
  claimsAccepted: number;
  claimsRejected: number;
  claimsReturned: number;
  claimsConfirmed: number;
  /** It answers a test file, which moves no claim. */
  testFile: boolean;
  /** Who said it, for the note: the clearinghouse by name, or "the payer"; null when unknown. */
  answeredBy: string | null;
  unmatched: number;
  errors: { claimRef: string | null; message: string }[];
}

interface SubmissionRow {
  id: string;
  vendor: ClearinghouseVendor;
  filename: string;
  /** ISA15: T for a file sent to the clearinghouse's test system, which never reaches a payer. */
  usage_indicator: "T" | "P";
}

/** A test file never reached the payer, so what comes back for it moves no claim. */
const isTest = (s: SubmissionRow | null) => s?.usage_indicator === "T";
const TEST_PREFIX = "Test file: ";
const TEST_STAYS = " The claim's status doesn't change: test files never reach the payer.";

/** A 277 status as kept on the claim, with who said it (older rows don't say). */
type StoredStatus = ClaimStatus277 & { source?: "clearinghouse" | "payer" | null };

interface ItemRow {
  submission_id: string;
  superbill_id: string;
  transaction_set_control_number: string;
  status: SuperbillStatus;
  is_latest: boolean;
}

const vendorName = (v: ClearinghouseVendor) => VENDOR_PROFILES[v]?.name ?? "the clearinghouse";

/** Items of a submission, with their claim's status and whether this is the claim's latest file. */
async function itemsOf(tx: Tx, orgId: string, submissionId: string): Promise<ItemRow[]> {
  return tx.$queryRaw<ItemRow[]>`
    SELECT i.submission_id, i.superbill_id, i.transaction_set_control_number, s.status,
           NOT EXISTS (
             SELECT 1 FROM claim_submission_item j JOIN claim_submission js ON js.id = j.submission_id
              WHERE j.superbill_id = i.superbill_id AND js.created_at > cs.created_at
           ) AS is_latest
      FROM claim_submission_item i
      JOIN claim_submission cs ON cs.id = i.submission_id
      JOIN superbill s ON s.id = i.superbill_id AND s.org_id = i.org_id
     WHERE i.org_id = ${orgId}::uuid AND i.submission_id = ${submissionId}::uuid
  `;
}

async function trail(tx: Tx, a: { orgId: string; userId: string | null; superbillId: string; status: string; summary: string; detail: Record<string, unknown> }): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO superbill_activity (org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail, at)
    VALUES (${a.orgId}::uuid, ${a.superbillId}::uuid, ${a.userId}::uuid, 'clearinghouse', ${a.status}, ${a.status},
            ${a.summary.slice(0, 1000)}, ${JSON.stringify(a.detail)}::jsonb, clock_timestamp())
  `;
}

/**
 * A claim rejected before the payer processed it: back to ready to submit
 * when it is submitted and this was its latest file; otherwise (already back,
 * or sent again since, or a test file that never moved it) the rejection is
 * only recorded on its history.
 */
async function rejectClaim(
  tx: Tx,
  a: { orgId: string; userId: string | null; item: { superbill_id: string; status: SuperbillStatus; is_latest: boolean }; submission: SubmissionRow; why: string },
): Promise<boolean> {
  if (isTest(a.submission)) {
    await trail(tx, {
      orgId: a.orgId, userId: a.userId, superbillId: a.item.superbill_id, status: a.item.status,
      summary: `${TEST_PREFIX}${vendorName(a.submission.vendor)} rejected the claim in ${a.submission.filename} — ${a.why}.${TEST_STAYS}`,
      detail: { submissionId: a.submission.id, event: "rejected", test: true },
    });
    return false;
  }
  if (a.item.status === "submitted" && a.item.is_latest) {
    await markStatusTx(tx, {
      orgId: a.orgId,
      id: a.item.superbill_id,
      to: "ready_to_submit",
      actorUserId: a.userId ?? undefined,
      source: { kind: "clearinghouse", event: "rejected", submissionId: a.submission.id, vendorName: vendorName(a.submission.vendor), filename: a.submission.filename, detail: a.why },
    });
    return true;
  }
  await trail(tx, {
    orgId: a.orgId, userId: a.userId, superbillId: a.item.superbill_id, status: a.item.status,
    summary: `${vendorName(a.submission.vendor)} rejected the claim in ${a.submission.filename}${a.item.is_latest ? "" : " (an earlier file; it has been sent again since)"} — ${a.why}`,
    detail: { submissionId: a.submission.id, event: "rejected" },
  });
  return false;
}

/** The submission a 999 group or TA1 answers, found by its own control number. */
async function submissionBy(tx: Tx, orgId: string, by: { gcn?: number | null; icn?: number | null }): Promise<SubmissionRow | null> {
  if (by.gcn) {
    const r = await tx.$queryRaw<SubmissionRow[]>`
      SELECT id, vendor, filename, usage_indicator FROM claim_submission WHERE org_id = ${orgId}::uuid AND group_control_number = ${by.gcn}
    `;
    return r[0] ?? null;
  }
  if (by.icn) {
    const r = await tx.$queryRaw<SubmissionRow[]>`
      SELECT id, vendor, filename, usage_indicator FROM claim_submission WHERE org_id = ${orgId}::uuid AND interchange_control_number = ${by.icn}
    `;
    return r[0] ?? null;
  }
  return null;
}

function blankReport(fileId: string, kind: ClearinghouseFileKind): FileReport {
  return {
    fileId, kind, alreadyRead: false, outcome: "nothing_to_apply", note: "",
    claimsUpdated: 0, claimsAccepted: 0, claimsRejected: 0, claimsReturned: 0, claimsConfirmed: 0, testFile: false, answeredBy: null,
    unmatched: 0, errors: [],
  };
}

const claims = (n: number) => `${n} claim${n === 1 ? "" : "s"}`;

/**
 * A file's claims in a sentence or two: what it said, then what Pallio did —
 * "The payer accepted 3 claims and rejected 1: it's back in Ready to submit,
 * and its bill says what to fix."
 */
function claimsNote(rep: FileReport): string {
  const who = rep.answeredBy ?? "the clearinghouse";
  const kept = rep.claimsRejected - rep.claimsReturned;
  const other = rep.claimsUpdated - rep.claimsAccepted - rep.claimsRejected;
  const one = (n: number, single: string, many: string) => (n === 1 ? single : many);
  const out: string[] = [];
  const said = [
    rep.claimsAccepted > 0 && `accepted ${claims(rep.claimsAccepted)}`,
    rep.claimsRejected > 0 && `rejected ${rep.claimsAccepted > 0 ? rep.claimsRejected : claims(rep.claimsRejected)}`,
  ].filter(Boolean).join(" and ");
  if (said) {
    let s = rep.testFile ? `Test file: ${who} ${said}` : `${who.charAt(0).toUpperCase()}${who.slice(1)} ${said}`;
    if (rep.testFile && rep.claimsRejected > 0) {
      s += ". Nothing changes: test files never reach the payer";
    } else if (rep.claimsReturned > 0) {
      const r = rep.claimsReturned;
      s += `: ${kept > 0 ? `${r} ${one(r, "is", "are")}` : one(r, "it's", "they're")} back in Ready to submit, and ${one(r, "its bill says", "their bills say")} what to fix`;
      if (kept > 0) s += `; ${kept} had been sent again or updated since, so ${one(kept, "it's", "they're")} only noted on the history`;
    } else if (kept > 0) {
      s += `. ${one(kept, "It had", "They had")} been sent again or updated since, so the rejection is only noted on ${one(kept, "its", "their")} history`;
    }
    out.push(`${s}.`);
  }
  if (other > 0) out.push(`${said ? `A status for ${other} more` : `A status for ${claims(other)}`} is noted on ${one(other, "its", "their")} history.`);
  if (rep.claimsConfirmed > 0) out.push(`${claims(rep.claimsConfirmed)} uploaded by hand ${one(rep.claimsConfirmed, "is", "are")} now marked Submitted.`);
  if (rep.unmatched > 0) {
    out.push(out.length > 0
      ? `${rep.unmatched} more didn't match a claim Pallio sent, so ${one(rep.unmatched, "it was", "they were")} skipped.`
      : "Nothing in it matched a claim Pallio sent, so nothing changed.");
  }
  if (rep.errors.length > 0) {
    const refs = rep.errors.map((e) => e.claimRef).filter(Boolean).slice(0, 3).join(", ");
    out.push(`${claims(rep.errors.length)} couldn't be updated${refs ? ` (${refs})` : ""}: open ${one(rep.errors.length, "its bill", "their bills")} and check the status.`);
  }
  return out.length > 0 ? out.join(" ") : "It lists no claims, so nothing changed.";
}

async function apply999(orgId: string, userId: string | null, text: string, rep: FileReport): Promise<{ submissionIds: string[] }> {
  const ack = parse999(text);
  const submissionIds: string[] = [];
  // A TA1 riding on the 999 rejects the whole interchange.
  if (ack.ta1 && ack.ta1.status === "R") {
    await applyTa1Result(orgId, userId, ack.ta1, rep, submissionIds);
  }
  for (const g of ack.groups) {
    const sub = await withOrgContext(orgId, (tx) => submissionBy(tx, orgId, { gcn: g.groupControlNumber }));
    if (!sub) {
      rep.unmatched += 1;
      continue;
    }
    submissionIds.push(sub.id);
    rep.answeredBy = vendorName(sub.vendor);
    const sets = ack.sets.filter((s) => s.groupControlNumber === g.groupControlNumber);
    const items = await withOrgContext(orgId, (tx) => itemsOf(tx, orgId, sub.id));
    // A group rejected with no set named rejects every claim in it.
    const answers = sets.length > 0
      ? sets.map((s) => ({ st02: s.controlNumber, status: s.status, codes: s.codes, errors: s.errors }))
      : g.status === "R"
        ? items.map((i) => ({ st02: i.transaction_set_control_number, status: "R", codes: g.codes, errors: [] as AckSegmentError[] }))
        : [];
    for (const a of answers) {
      const item = items.find((i) => Number(i.transaction_set_control_number) === Number(a.st02));
      if (!item) {
        rep.unmatched += 1;
        continue;
      }
      const state = setAckState(a.status);
      const described = a.errors.map(describeAckError);
      const why = state === "rejected"
        ? `999 ${ACK_STATUSES[a.status] ?? a.status}${described.length > 0 ? `: ${described.join("; ")}` : a.codes.length > 0 ? ` (codes ${a.codes.join(", ")})` : ""}`
        : `999 ${ACK_STATUSES[a.status] ?? a.status}`;
      try {
        const returned = await withOrgContext(orgId, async (tx) => {
          await tx.$executeRaw`
            UPDATE claim_submission_item SET
              ack_state = ${state}, ack_errors = ${JSON.stringify(a.errors.map((e) => ({ ...e, text: describeAckError(e) })))}::jsonb,
              ack_at = now(), updated_at = now()
             WHERE org_id = ${orgId}::uuid AND submission_id = ${sub.id}::uuid AND superbill_id = ${item.superbill_id}::uuid
          `;
          if (state === "rejected") return rejectClaim(tx, { orgId, userId, item, submission: sub, why });
          await trail(tx, {
            orgId, userId, superbillId: item.superbill_id, status: item.status,
            summary: `${isTest(sub) ? TEST_PREFIX : ""}${vendorName(sub.vendor)} accepted the claim in ${sub.filename} (${why})`,
            detail: { submissionId: sub.id, event: "ack", ack: state, ...(isTest(sub) ? { test: true } : {}) },
          });
          return false;
        });
        rep.claimsUpdated += 1;
        if (state === "rejected") rep.claimsRejected += 1;
        else rep.claimsAccepted += 1;
        if (returned) rep.claimsReturned += 1;
        if (isTest(sub)) rep.testFile = true;
      } catch (err) {
        rep.errors.push({ claimRef: claimRefFor(item.superbill_id), message: messageOf(err) });
      }
    }
    await withOrgContext(orgId, (tx) => tx.$executeRaw`
      UPDATE claim_submission SET ack_state = ${groupAckState(g.status)}, ack_at = now()
       WHERE org_id = ${orgId}::uuid AND id = ${sub.id}::uuid
    `);
  }
  return { submissionIds };
}

async function applyTa1Result(
  orgId: string,
  userId: string | null,
  ta1: { interchangeControlNumber: number | null; status: string; noteCode: string },
  rep: FileReport,
  submissionIds: string[],
): Promise<void> {
  const sub = await withOrgContext(orgId, (tx) => submissionBy(tx, orgId, { icn: ta1.interchangeControlNumber }));
  if (!sub) {
    rep.unmatched += 1;
    return;
  }
  submissionIds.push(sub.id);
  rep.answeredBy = vendorName(sub.vendor);
  if (ta1.status !== "R") {
    await withOrgContext(orgId, (tx) => tx.$executeRaw`
      UPDATE claim_submission SET ack_at = COALESCE(ack_at, now()) WHERE org_id = ${orgId}::uuid AND id = ${sub.id}::uuid
    `);
    return;
  }
  const why = `TA1: the whole file was rejected — ${TA1_NOTES[ta1.noteCode] ?? `note ${ta1.noteCode}`}`;
  const items = await withOrgContext(orgId, (tx) => itemsOf(tx, orgId, sub.id));
  for (const item of items) {
    try {
      const returned = await withOrgContext(orgId, async (tx) => {
        await tx.$executeRaw`
          UPDATE claim_submission_item SET ack_state = 'rejected', ack_at = now(), updated_at = now()
           WHERE org_id = ${orgId}::uuid AND submission_id = ${sub.id}::uuid AND superbill_id = ${item.superbill_id}::uuid
        `;
        return rejectClaim(tx, { orgId, userId, item, submission: sub, why });
      });
      rep.claimsUpdated += 1;
      rep.claimsRejected += 1;
      if (returned) rep.claimsReturned += 1;
      if (isTest(sub)) rep.testFile = true;
    } catch (err) {
      rep.errors.push({ claimRef: claimRefFor(item.superbill_id), message: messageOf(err) });
    }
  }
  await withOrgContext(orgId, (tx) => tx.$executeRaw`
    UPDATE claim_submission SET ack_state = 'rejected', ack_at = now(), error_message = ${why}
     WHERE org_id = ${orgId}::uuid AND id = ${sub.id}::uuid
  `);
}

/** The claim a 277 answers, by its patient control number (the Claim ref), and its latest file. */
async function claimFor277(tx: Tx, orgId: string, pcn: string): Promise<{
  superbillId: string; status: SuperbillStatus; submission: SubmissionRow | null; lastPayerDay: string | null;
} | null> {
  const bounds = claimRefBounds(pcn);
  if (!bounds) return null;
  const bills = await tx.$queryRaw<{ id: string; status: SuperbillStatus }[]>`
    SELECT id, status FROM superbill
     WHERE org_id = ${orgId}::uuid AND id BETWEEN ${bounds.lo}::uuid AND ${bounds.hi}::uuid
     ORDER BY id LIMIT 2 FOR UPDATE
  `;
  if (bills.length !== 1) return null;
  const sub = await tx.$queryRaw<(SubmissionRow & { payer_day: string | null })[]>`
    SELECT cs.id, cs.vendor, cs.filename, cs.usage_indicator,
           (SELECT max((st->>'effectiveDate')) FROM jsonb_array_elements(COALESCE(i.payer_statuses, '[]'::jsonb)) st) AS payer_day
      FROM claim_submission_item i JOIN claim_submission cs ON cs.id = i.submission_id
     WHERE i.org_id = ${orgId}::uuid AND i.superbill_id = ${bills[0]!.id}::uuid
     ORDER BY cs.created_at DESC LIMIT 1
  `;
  return { superbillId: bills[0]!.id, status: bills[0]!.status, submission: sub[0] ?? null, lastPayerDay: sub[0]?.payer_day ?? null };
}

const latestDay = (sts: ClaimStatus277[]) => sts.map((s) => s.effectiveDate).filter((d): d is string => Boolean(d)).sort().pop() ?? null;

async function apply277(orgId: string, userId: string | null, text: string, rep: FileReport): Promise<void> {
  const doc = parse277(text);
  const label = doc.kind === "277ca" ? "277CA" : "277";
  // A rejection above claim level (the submitter or the billing provider)
  // names no claim, so nothing here can say which bills it returns. It is
  // said on the file instead, flagged, for a person to match to what was sent.
  const above = doc.batchStatuses.find(isRejection);
  if (above && doc.claims.length === 0) {
    rep.unmatched += 1;
    const next = rejectionNextStep(above).replace(/send the claim again\.$/, "send its claims again.");
    rep.note = `The whole batch was rejected, so no claim is named and no bill was changed. Reason: ${plainStatus(above)}. ${next} Its claims are in the file it answers, under Claim files sent.`;
    return;
  }
  // Availity's own 277CA (its IBR) speaks for Availity: the claim passed its
  // checks, and the payer's acceptance is still to come.
  const fromClearinghouse = doc.source === "clearinghouse";
  rep.answeredBy = fromClearinghouse ? null : "the payer";
  for (const c of doc.claims) {
    try {
      await withOrgContext(orgId, async (tx) => {
        const hit = await claimFor277(tx, orgId, c.patientControlNumber);
        if (!hit) {
          rep.unmatched += 1;
          return;
        }
        const state = claimState277(c.statuses);
        const day = latestDay(c.statuses);
        // An answer older than one already recorded is history, not news: it
        // goes on the trail and moves nothing (files can arrive out of order).
        const stale = Boolean(day && hit.lastPayerDay && day < hit.lastPayerDay);
        const first = c.statuses.find(isRejection) ?? c.statuses[0];
        const said = first ? describeStatus(first) : "no status";
        const who = !fromClearinghouse ? "the payer" : hit.submission ? vendorName(hit.submission.vendor) : "the clearinghouse";
        if (fromClearinghouse && hit.submission) rep.answeredBy = who;
        // The same goes for a clearinghouse's acceptance read after the payer's
        // answer: it doesn't take the payer's place.
        const keepPayers = fromClearinghouse && state !== "rejected";
        const stored: StoredStatus[] = c.statuses.map((st) => ({ ...st, source: doc.source }));
        if (hit.submission) {
          await tx.$executeRaw`
            UPDATE claim_submission_item SET
              payer_state = CASE WHEN ${keepPayers} AND COALESCE(payer_statuses, '[]'::jsonb) @> '[{"source":"payer"}]'::jsonb
                                 THEN payer_state ELSE COALESCE(${stale ? null : state}, payer_state) END,
              payer_statuses = CASE WHEN ${keepPayers} AND COALESCE(payer_statuses, '[]'::jsonb) @> '[{"source":"payer"}]'::jsonb
                                    THEN payer_statuses ELSE ${JSON.stringify(stored)}::jsonb END,
              payer_claim_number = COALESCE(${c.payerClaimNumber}, payer_claim_number),
              clearinghouse_trace = COALESCE(${c.clearinghouseTrace}, clearinghouse_trace),
              payer_at = now(), updated_at = now()
             WHERE org_id = ${orgId}::uuid AND submission_id = ${hit.submission.id}::uuid AND superbill_id = ${hit.superbillId}::uuid
          `;
        }
        const sub = hit.submission ?? { id: "", vendor: "availity" as ClearinghouseVendor, filename: "a file not built by Pallio", usage_indicator: "P" as const };
        const test = isTest(hit.submission);
        if (!stale && !test && doc.kind === "277ca" && state === "rejected" && hit.status === "submitted" && hit.submission) {
          await markStatusTx(tx, {
            orgId, id: hit.superbillId, to: "ready_to_submit", actorUserId: userId ?? undefined,
            source: { kind: "clearinghouse", event: "rejected", submissionId: sub.id, vendorName: vendorName(sub.vendor), filename: sub.filename, detail: `${label} from ${who}: ${said}` },
          });
          rep.claimsReturned += 1;
        } else if (!stale && !test && doc.kind === "277ca" && state === "accepted" && hit.status === "ready_to_submit" && hit.submission) {
          // The practice sent this file itself (downloaded from Pallio): the
          // acknowledgment is the proof it went, as an 835 is (audit R10).
          await markStatusTx(tx, {
            orgId, id: hit.superbillId, to: "submitted", actorUserId: userId ?? undefined,
            source: { kind: "clearinghouse", event: "accepted", submissionId: sub.id, vendorName: vendorName(sub.vendor), filename: sub.filename, detail: `${label} from ${who}: ${said}` },
          });
          rep.claimsConfirmed += 1;
        } else {
          await trail(tx, {
            orgId, userId, superbillId: hit.superbillId, status: hit.status,
            summary: `${test ? TEST_PREFIX : ""}${label} from ${who}: ${said}${c.payerClaimNumber ? ` · payer claim # ${c.payerClaimNumber}` : ""}${stale ? " (older than the status already on file)" : ""}${test && state === "rejected" ? `.${TEST_STAYS}` : ""}`,
            detail: { submissionId: hit.submission?.id ?? null, event: doc.kind, state, stale, ...(test ? { test: true } : {}) },
          });
        }
        rep.claimsUpdated += 1;
        if (state === "rejected") rep.claimsRejected += 1;
        else if (state === "accepted") rep.claimsAccepted += 1;
        if (test) rep.testFile = true;
      });
    } catch (err) {
      rep.errors.push({ claimRef: c.patientControlNumber.slice(0, 20), message: messageOf(err) });
    }
  }
}

/** Availity's "<file><batch id>-success" / "-FAILED" notice in SendFiles (guide p. 76). */
async function applyNotification(orgId: string, userId: string | null, name: string, text: string, rep: FileReport): Promise<void> {
  const failed = /-failed$/i.test(name);
  const sub = await withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<SubmissionRow[]>`
      SELECT id, vendor, filename, usage_indicator FROM claim_submission
       WHERE org_id = ${orgId}::uuid AND ${name} LIKE filename || '%'
       ORDER BY length(filename) DESC LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (!sub) {
    rep.unmatched += 1;
    return;
  }
  if (!failed) {
    rep.note = `${vendorName(sub.vendor)} received ${sub.filename} and began checking it.`;
    return;
  }
  rep.answeredBy = vendorName(sub.vendor);
  const why = `${vendorName(sub.vendor)} could not read the file: ${text.replace(/\s+/g, " ").trim().slice(0, 200) || "no reason given"}`;
  const items = await withOrgContext(orgId, (tx) => itemsOf(tx, orgId, sub.id));
  for (const item of items) {
    try {
      const returned = await withOrgContext(orgId, async (tx) => {
        await tx.$executeRaw`
          UPDATE claim_submission_item SET ack_state = 'rejected', ack_at = now(), updated_at = now()
           WHERE org_id = ${orgId}::uuid AND submission_id = ${sub.id}::uuid AND superbill_id = ${item.superbill_id}::uuid
        `;
        return rejectClaim(tx, { orgId, userId, item, submission: sub, why });
      });
      rep.claimsUpdated += 1;
      rep.claimsRejected += 1;
      if (returned) rep.claimsReturned += 1;
      if (isTest(sub)) rep.testFile = true;
    } catch (err) {
      rep.errors.push({ claimRef: claimRefFor(item.superbill_id), message: messageOf(err) });
    }
  }
  await withOrgContext(orgId, (tx) => tx.$executeRaw`
    UPDATE claim_submission SET ack_state = 'rejected', ack_at = now(), error_message = ${why.slice(0, 1000)}
     WHERE org_id = ${orgId}::uuid AND id = ${sub.id}::uuid
  `);
}

function messageOf(err: unknown): string {
  const typed = err instanceof ValidationError || err instanceof NotFoundError;
  if (!typed) reportError(err, { source: "clearinghouse-inbound" });
  return typed ? (err as Error).message : "This claim couldn't be updated. Open its bill and check its status.";
}

/**
 * Read one file. `text` is the file's content; `connectionId` is the
 * connection it came through (null for an upload not tied to one).
 */
export async function ingestClearinghouseFile(args: {
  orgId: string;
  userId: string | null;
  connectionId: string | null;
  source: "sftp" | "upload" | "realtime";
  name: string;
  text: string;
  remoteSize?: number | null;
}): Promise<FileReport> {
  const name = args.name.trim().slice(0, 255) || "response";
  const { kind, note } = classifyClearinghouseFile(name, args.text);
  // A notice says which file it answers in its name; its text is the same
  // for every file ("File received"), so for a notice the name is part of
  // what makes it one file and not another.
  const sha256 = createHash("sha256").update(kind === "notification" ? `${name}\n${args.text}` : args.text).digest("hex");

  // Once per org: the same file read again (re-uploaded, or still on the
  // server at the next poll) applies nothing a second time. An 835 is read
  // again all the same: the remittance posting never posts a claim twice, and
  // retries the claims it held or could not match last time, as an upload on
  // the Remittances page does.
  const existing = await withOrgContext(args.orgId, (tx) => tx.$queryRaw<{ id: string; kind: ClearinghouseFileKind; outcome: FileReport["outcome"]; summary: Record<string, unknown> }[]>`
    SELECT id, kind, outcome, summary FROM clearinghouse_file WHERE org_id = ${args.orgId}::uuid AND sha256 = ${sha256}
  `);
  if (existing[0] && existing[0].kind !== "835") {
    const s = existing[0].summary as Partial<FileReport>;
    return {
      ...blankReport(existing[0].id, existing[0].kind),
      alreadyRead: true,
      outcome: existing[0].outcome,
      note: `Already read on an earlier ${args.source === "sftp" ? "check" : "upload"}; nothing was applied again.${s.note ? ` It said: ${s.note}` : ""}`,
    };
  }

  const rep = blankReport("", kind);
  rep.alreadyRead = Boolean(existing[0]);
  let remittanceFileId: string | null = null;
  let submissionIds: string[] = [];
  try {
    switch (kind) {
      case "999":
        submissionIds = (await apply999(args.orgId, args.userId, args.text, rep)).submissionIds;
        break;
      case "ta1": {
        const ta1 = parseTa1(readX12(args.text));
        if (ta1) await applyTa1Result(args.orgId, args.userId, ta1, rep, submissionIds);
        break;
      }
      case "277ca":
      case "277":
        await apply277(args.orgId, args.userId, args.text, rep);
        break;
      case "835": {
        // Payers don't pay test claims, so an 835 in a test connection's
        // folders is a sample; posting it would mark real bills paid.
        const env = args.connectionId
          ? (await withOrgContext(args.orgId, (tx) => tx.$queryRaw<{ environment: string }[]>`
              SELECT environment FROM clearinghouse_connection WHERE org_id = ${args.orgId}::uuid AND id = ${args.connectionId}::uuid
            `))[0]?.environment
          : null;
        if (env === "test") {
          rep.note = "Read from a test connection, so nothing was posted: payers don't pay test claims. If this is a real remittance, upload it on Billing → Remittances.";
          break;
        }
        const r = await ingestRemittance({ orgId: args.orgId, userId: args.userId, filename: name, text: args.text, via: args.source === "sftp" ? "sftp" : "upload" });
        remittanceFileId = r.fileId;
        rep.claimsUpdated = r.counts.paid + r.counts.partiallyPaid + r.counts.denied;
        rep.unmatched = r.counts.unmatched;
        // Only the counts that happened: "3 claims: 2 paid, 1 denied", or "1 claim paid".
        const counted = ([
          [r.counts.paid, "paid"],
          [r.counts.partiallyPaid, "partly paid"],
          [r.counts.denied, "denied"],
          [r.counts.needsReview, "held for review (see Billing → Remittances)"],
          [r.counts.unmatched, "not found in Pallio"],
          [r.counts.alreadyPosted, "posted before"],
        ] as const).filter(([n]) => n > 0);
        const only = counted.length === 1 && counted[0]![0] === r.counts.claims ? counted[0]![1] : null;
        rep.note = `${r.alreadyUploaded ? "Read again: " : ""}${claims(r.counts.claims)}${
          only ? ` ${only}` : counted.length > 0 ? `: ${counted.map(([n, w]) => `${n} ${w}`).join(", ")}` : ""
        }.`;
        break;
      }
      case "notification":
        await applyNotification(args.orgId, args.userId, name, args.text, rep);
        break;
      case "271":
        rep.note = "A 271 arrives in answer to a real-time eligibility check, which records it on the chart; a 271 file on its own is kept as read.";
        break;
      case "vendor_report":
        rep.note = "The clearinghouse's own report. Pallio reads the X12 files (999, 277CA, 835); this one is recorded as received.";
        break;
      default:
        rep.outcome = "failed";
        rep.note = note ?? "Not a file Pallio can read.";
    }
  } catch (err) {
    rep.outcome = "failed";
    rep.note = err instanceof ValidationError ? err.message : "The file could not be read.";
    if (!(err instanceof ValidationError)) reportError(err, { source: "ingestClearinghouseFile" });
  }
  if (rep.outcome !== "failed") {
    rep.outcome = rep.claimsUpdated > 0 ? "applied" : rep.unmatched > 0 ? "unmatched" : "nothing_to_apply";
  }
  if (!rep.note) rep.note = claimsNote(rep);

  const summary = {
    note: rep.note,
    claimsUpdated: rep.claimsUpdated,
    claimsReturned: rep.claimsReturned,
    claimsConfirmed: rep.claimsConfirmed,
    unmatched: rep.unmatched,
    errors: rep.errors.length,
    submissionIds,
  };
  const fileId = await withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO clearinghouse_file (
        org_id, connection_id, source, remote_name, remote_size, kind, sha256, byte_size, received_by_user_id,
        outcome, summary, error_message, remittance_file_id
      ) VALUES (
        ${args.orgId}::uuid, ${args.connectionId}::uuid, ${args.source}, ${name}, ${args.remoteSize ?? null}::bigint,
        ${kind}, ${sha256}, ${Buffer.byteLength(args.text)}::int, ${args.userId}::uuid,
        ${rep.outcome}, ${JSON.stringify(summary)}::jsonb,
        ${rep.outcome === "failed" ? rep.note.slice(0, 1000) : null}, ${remittanceFileId}::uuid
      )
      -- An 835 read again that posted what it held last time says so.
      ON CONFLICT (org_id, sha256) DO UPDATE
        SET outcome = EXCLUDED.outcome, summary = EXCLUDED.summary, error_message = EXCLUDED.error_message
        WHERE clearinghouse_file.kind = '835' AND EXCLUDED.outcome = 'applied'
      RETURNING id
    `;
    const id = rows[0]?.id ?? (await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM clearinghouse_file WHERE org_id = ${args.orgId}::uuid AND sha256 = ${sha256}
    `)[0]!.id;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "clearinghouse_file",
      targetType: "clearinghouse_file",
      targetId: id,
      payload: {
        kind, source: args.source, outcome: rep.outcome, claimsUpdated: rep.claimsUpdated,
        claimsReturned: rep.claimsReturned, claimsConfirmed: rep.claimsConfirmed, unmatched: rep.unmatched,
      },
    });
    return id;
  });
  return { ...rep, fileId };
}

export interface ClearinghouseFileView {
  id: string;
  kind: ClearinghouseFileKind;
  source: "sftp" | "upload" | "realtime";
  remoteName: string | null;
  connectionLabel: string | null;
  receivedAt: string;
  receivedByName: string | null;
  outcome: FileReport["outcome"];
  note: string;
}

export async function listClearinghouseFiles(args: { orgId: string; limit?: number }): Promise<ClearinghouseFileView[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string; kind: ClearinghouseFileKind; source: "sftp" | "upload" | "realtime"; remote_name: string | null; label: string | null; received_at: Date; by_name: string | null; outcome: FileReport["outcome"]; summary: Record<string, unknown> }[]
    >`
      SELECT f.id, f.kind, f.source, f.remote_name, c.label, f.received_at, COALESCE(u.full_name, u.email) AS by_name,
             f.outcome, f.summary
        FROM clearinghouse_file f
        LEFT JOIN clearinghouse_connection c ON c.id = f.connection_id
        LEFT JOIN app_user u ON u.id = f.received_by_user_id
       WHERE f.org_id = ${args.orgId}::uuid
       ORDER BY f.received_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id, kind: r.kind, source: r.source, remoteName: r.remote_name, connectionLabel: r.label,
      receivedAt: r.received_at.toISOString(), receivedByName: r.by_name, outcome: r.outcome,
      note: typeof r.summary?.note === "string" ? (r.summary.note as string) : "",
    }));
  });
}

export interface SubmissionView {
  id: string;
  vendor: ClearinghouseVendor;
  vendorName: string;
  connectionLabel: string | null;
  channel: "sftp" | "download";
  usage: "T" | "P";
  filename: string;
  interchangeControlNumber: number;
  claimCount: number;
  state: "sending" | "sent" | "send_failed" | "downloaded";
  ackState: string | null;
  errorMessage: string | null;
  createdAt: string;
  createdByName: string | null;
  claims: {
    superbillId: string;
    claimRef: string;
    visitId: string | null;
    status: string;
    sendState: string;
    ackState: string | null;
    ackErrors: string[];
    payerState: string | null;
    payerStatus: string | null;
    /** Whose 277 that status is: the clearinghouse's own or the payer's (null for older rows). */
    payerSaidBy: "clearinghouse" | "payer" | null;
    payerClaimNumber: string | null;
  }[];
}

export async function listSubmissions(args: { orgId: string; limit?: number }): Promise<SubmissionView[]> {
  const limit = Math.min(100, Math.max(1, args.limit ?? 30));
  return withOrgContext(args.orgId, async (tx) => {
    const subs = await tx.$queryRaw<
      { id: string; vendor: ClearinghouseVendor; label: string | null; channel: "sftp" | "download"; usage_indicator: "T" | "P"; filename: string; icn: bigint; claim_count: number; state: SubmissionView["state"]; ack_state: string | null; error_message: string | null; created_at: Date; by_name: string | null }[]
    >`
      SELECT s.id, s.vendor, c.label, s.channel, s.usage_indicator, s.filename, s.interchange_control_number AS icn,
             s.claim_count, s.state, s.ack_state, s.error_message, s.created_at, COALESCE(u.full_name, u.email) AS by_name
        FROM claim_submission s
        LEFT JOIN clearinghouse_connection c ON c.id = s.connection_id
        LEFT JOIN app_user u ON u.id = s.created_by_user_id
       WHERE s.org_id = ${args.orgId}::uuid
       ORDER BY s.created_at DESC
       LIMIT ${limit}
    `;
    if (subs.length === 0) return [];
    const items = await tx.$queryRaw<
      { submission_id: string; superbill_id: string; claim_ref: string; visit_id: string | null; status: string; send_state: string; ack_state: string | null; ack_errors: StoredAckError[] | null; payer_state: string | null; payer_statuses: StoredStatus[] | null; payer_claim_number: string | null }[]
    >`
      SELECT i.submission_id, i.superbill_id, i.claim_ref, sb.visit_id, sb.status, i.send_state, i.ack_state, i.ack_errors,
             i.payer_state, i.payer_statuses, i.payer_claim_number
        FROM claim_submission_item i
        JOIN superbill sb ON sb.id = i.superbill_id
       WHERE i.org_id = ${args.orgId}::uuid AND i.submission_id = ANY(${subs.map((s) => s.id)}::uuid[])
       ORDER BY i.transaction_set_control_number
    `;
    return subs.map((s) => ({
      id: s.id,
      vendor: s.vendor,
      vendorName: vendorName(s.vendor),
      connectionLabel: s.label,
      channel: s.channel,
      usage: s.usage_indicator,
      filename: s.filename,
      interchangeControlNumber: Number(s.icn),
      claimCount: Number(s.claim_count),
      state: s.state,
      ackState: s.ack_state,
      errorMessage: s.error_message,
      createdAt: s.created_at.toISOString(),
      createdByName: s.by_name,
      claims: items
        .filter((i) => i.submission_id === s.id)
        .map((i) => ({
          superbillId: i.superbill_id,
          claimRef: i.claim_ref,
          visitId: i.visit_id,
          status: i.status,
          sendState: i.send_state,
          ackState: i.ack_state,
          ackErrors: ackErrorTexts(i.ack_errors),
          payerState: i.payer_state,
          payerStatus: payerWords(i.payer_statuses, vendorName(s.vendor)),
          payerSaidBy: (i.payer_statuses?.find(isRejection) ?? i.payer_statuses?.[0])?.source ?? null,
          payerClaimNumber: i.payer_claim_number,
        })),
    }));
  });
}

/** A 999 error as stored on the claim: the parsed error, and the words it was given when read. */
type StoredAckError = Partial<AckSegmentError> & { text?: string };

/** Said again in today's words when the parsed error is there (older rows), else as stored. */
function ackErrorTexts(errs: StoredAckError[] | null): string[] {
  return (errs ?? [])
    .map((e) => (e.segment ? describeAckError({ segment: e.segment, position: e.position ?? "", loop: e.loop ?? "", code: e.code ?? "", elements: e.elements ?? [] }) : e.text ?? ""))
    .filter(Boolean);
}

/** The latest 277 word on a claim, and whose it is: a rejection's reason said plainly, else its latest status. */
function payerWords(statuses: StoredStatus[] | null, vendor: string): string | null {
  const st = statuses?.find(isRejection) ?? statuses?.[0];
  if (!st) return null;
  const who = st.source === "clearinghouse" ? `${vendor}: ` : st.source === "payer" ? "Payer: " : "";
  return `${who}${isRejection(st) ? plainStatus(st) : describeStatus(st)}`;
}

export interface ClaimClearinghouseStatus {
  vendorName: string;
  filename: string;
  sentAt: string;
  sendState: string;
  ackState: string | null;
  payerState: string | null;
  /** The file went to the clearinghouse's test system: it moved no claim. */
  test: boolean;
  /** One line: where the claim stands with the clearinghouse and the payer. */
  summary: string;
  /** After a rejection or a failed send: what to put right, and where, before sending again. */
  nextStep: string | null;
}

/** A bill the payer's remittance has answered: the 835 is the last word, over any 277. */
const REMITTED: Record<string, string> = {
  paid: "Paid by the payer",
  partially_paid: "Partly paid by the payer",
  denied: "Denied by the payer",
};

/** The clearinghouse's latest word on each claim, for the queue and the bill page. */
export async function claimClearinghouseStatus(args: { orgId: string; superbillIds: string[] }): Promise<Record<string, ClaimClearinghouseStatus>> {
  if (args.superbillIds.length === 0) return {};
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      { superbill_id: string; bill_status: string; vendor: ClearinghouseVendor; filename: string; usage_indicator: "T" | "P"; error_message: string | null; created_at: Date; send_state: string; ack_state: string | null; ack_errors: StoredAckError[] | null; payer_state: string | null; payer_statuses: StoredStatus[] | null; payer_claim_number: string | null; edited_since: boolean }[]
    >`
      SELECT DISTINCT ON (i.superbill_id) i.superbill_id, b.status AS bill_status, s.vendor, s.filename, s.usage_indicator, s.error_message, s.created_at,
             i.send_state, i.ack_state, i.ack_errors, i.payer_state, i.payer_statuses, i.payer_claim_number,
             -- The bill was changed after the clearinghouse's or the payer's last word on it.
             EXISTS (SELECT 1 FROM superbill_activity a
                      WHERE a.org_id = i.org_id AND a.superbill_id = i.superbill_id AND a.kind = 'edited'
                        AND a.at > COALESCE(i.payer_at, i.ack_at, s.created_at)) AS edited_since
        FROM claim_submission_item i
        JOIN claim_submission s ON s.id = i.submission_id
        JOIN superbill b ON b.id = i.superbill_id AND b.org_id = i.org_id
       WHERE i.org_id = ${args.orgId}::uuid AND i.superbill_id = ANY(${args.superbillIds}::uuid[])
       ORDER BY i.superbill_id, s.created_at DESC
    `;
    return Object.fromEntries(
      rows.map((r) => {
        const v = vendorName(r.vendor);
        const st = r.payer_statuses?.find(isRejection) ?? r.payer_statuses?.[0];
        const errs = r.ack_errors ?? [];
        let summary: string;
        let nextStep: string | null = null;
        const remitted = r.payer_state !== "rejected" && r.ack_state !== "rejected" ? REMITTED[r.bill_status] : undefined;
        if (remitted) {
          summary = `${remitted}${r.payer_claim_number ? ` · payer claim # ${r.payer_claim_number}` : ""}`;
          if (r.bill_status === "denied") nextStep = "See the payer's reason, and whether to correct, appeal or write it off, on Billing → Denials.";
        } else if (r.payer_state === "rejected") {
          summary = `Rejected by ${st?.source === "clearinghouse" ? v : "the payer"}: ${st ? plainStatus(st) : "no reason given"}`;
          nextStep = st ? rejectionNextStep(st) : NEXT_STEPS.other;
        } else if (r.ack_state === "rejected") {
          const reasons = ackErrorTexts(errs);
          summary = `Rejected by ${v}: ${reasons.length > 0 ? reasons.join("; ") : r.error_message ?? "no reason given"}`;
          const first = errs[0];
          nextStep = first?.segment
            ? ackErrorNextStep({ segment: first.segment, position: first.position ?? "", loop: first.loop ?? "", code: first.code ?? "", elements: first.elements ?? [] })
            : NEXT_STEPS.wholeFile;
        } else if (r.payer_state === "accepted" && st?.source === "clearinghouse") {
          summary = `Accepted by ${v} · waiting for the payer to accept it`;
        } else if (r.payer_state === "accepted") {
          summary = `Accepted by the payer for processing${r.payer_claim_number ? ` · payer claim # ${r.payer_claim_number}` : ""}`;
        } else if (r.payer_state === "finalized" || r.payer_state === "pending") {
          summary = `Payer status: ${st ? describeStatus(st) : r.payer_state}`;
        } else if (r.ack_state === "accepted" || r.ack_state === "accepted_with_errors") {
          summary = `Accepted by ${v} · waiting for the payer to accept it`;
        } else if (r.send_state === "sent") {
          summary = `Sent to ${v} · waiting for ${v} to accept it`;
        } else if (r.send_state === "send_failed") {
          summary = `Not sent to ${v}${r.error_message ? `: ${r.error_message}` : ""}`;
          nextStep = `Nothing reached ${v}. An admin can check the connection with “Test connection” in Settings → Integrations; then send the claim again.`;
        } else if (r.send_state === "sending") {
          summary = `Sending to ${v}…`;
        } else {
          summary = `Downloaded for ${v} · upload the file in ${v}, then upload ${v}'s responses on Billing → Clearinghouse`;
        }
        // Rejected, and the bill has been put right since: what's left is to send it.
        const rejected = r.payer_state === "rejected" || r.ack_state === "rejected";
        if (!remitted && rejected && r.edited_since && r.bill_status === "draft") {
          nextStep = "The bill has been changed since. Check it, click “Mark ready to submit”, then send it again.";
        } else if (!remitted && rejected && r.edited_since && r.bill_status === "ready_to_submit") {
          nextStep = "The bill has been changed since and is ready to submit: send it again.";
        }
        const test = r.usage_indicator === "T";
        if (test && !remitted) summary = `${TEST_PREFIX}${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
        return [r.superbill_id, {
          vendorName: v, filename: r.filename, sentAt: r.created_at.toISOString(), sendState: r.send_state, ackState: r.ack_state,
          payerState: r.payer_state, test, summary, nextStep,
        } satisfies ClaimClearinghouseStatus];
      }),
    );
  });
}
