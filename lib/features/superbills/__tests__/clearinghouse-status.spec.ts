/**
 * markStatus and the clearinghouse (0120).
 *
 *   - Back from submitted to ready to submit is a clearinghouse's or payer
 *     front end's rejection only, read from its file: a person cannot do it
 *     (they record a denial), and neither can any other source.
 *   - The rejection takes the visit back out of billed, the mirror of the
 *     move to submitted.
 *   - A claim Pallio sent says so on its history, naming the file; a
 *     documentation override given before sending is recorded as one, and a
 *     gap with none is recorded rather than refused (the file has gone).
 *   - While a claim's file is uploading, a person can neither move nor edit
 *     it; the clearinghouse's own moves are not held.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text, as mark-status.spec.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";

import { assertNotSending, markStatus, updateSuperbill } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
const SUBMISSION = "44444444-4444-4444-8444-444444444444";

let currentStatus: string;
let sending: boolean;
let docFacts: Record<string, unknown> | null;
let docReqs: { code: string; required_chart_elements: string[] }[];
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT status, provider_npi, visit_id FROM superbill")) {
      return Promise.resolve([{ status: currentStatus, provider_npi: "1234567893", visit_id: VISIT }]);
    }
    if (sql.includes("SELECT id, status FROM superbill WHERE id")) return Promise.resolve([{ id: SB, status: currentStatus }]);
    if (sql.includes("FROM claim_submission_item i") && sql.includes("send_state = 'sending'")) {
      return Promise.resolve(sending ? [{ ok: 1 }] : []);
    }
    if (sql.includes("FROM superbill sb")) return Promise.resolve(docFacts ? [docFacts] : []);
    if (sql.includes("FROM documentation_requirement")) return Promise.resolve(docReqs);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  currentStatus = "submitted";
  sending = false;
  docFacts = null;
  docReqs = [];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const rejected = {
  kind: "clearinghouse" as const,
  event: "rejected" as const,
  submissionId: SUBMISSION,
  vendorName: "Availity",
  filename: "pallio-837p-000000077.txt",
  detail: "277CA: Rejected for invalid information — Subscriber and subscriber ID not found (33)",
};

const trail = () => calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"));
const audit = () => calls.find((c) => c.sql.includes("INSERT INTO audit_log"));

describe("back for correction (submitted → ready to submit)", () => {
  it("a person cannot do it: they record a denial", async () => {
    await expect(markStatus({ orgId: ORG, id: SB, to: "ready_to_submit", actorUserId: ACTOR })).rejects.toThrow(
      /comes back for correction only when the clearinghouse or the payer rejects it/,
    );
    expect(calls.some((c) => c.sql.includes("UPDATE superbill SET status = 'ready_to_submit'"))).toBe(false);
  });

  it("nor can a clearinghouse file that does not reject it, nor an 835", async () => {
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "ready_to_submit", source: { ...rejected, event: "accepted" } }),
    ).rejects.toThrow(/only when/);
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "ready_to_submit", source: { kind: "remittance", remittanceFileId: SUBMISSION, traceNumber: null } }),
    ).rejects.toThrow(/only when/);
  });

  it("CONTROL: a rejection read from the clearinghouse's file does it, and takes the visit out of billed", async () => {
    const r = await markStatus({ orgId: ORG, id: SB, to: "ready_to_submit", source: rejected });
    expect(r).toEqual({ from: "submitted", to: "ready_to_submit" });
    expect(calls.some((c) => c.sql.includes("UPDATE superbill SET status = 'ready_to_submit'"))).toBe(true);
    const visit = calls.find((c) => c.sql.includes("UPDATE visit SET status = 'pending_billing'"));
    expect(visit).toBeDefined();
    expect(visit!.sql).toContain("status = 'billed'");
  });

  it("says why on the claim's history and in the audit row (ids and the event only)", async () => {
    await markStatus({ orgId: ORG, id: SB, to: "ready_to_submit", source: rejected });
    expect(trail()!.values).toContain(
      "Returned for correction: rejected before the payer processed it (Availity, pallio-837p-000000077.txt) — 277CA: Rejected for invalid information — Subscriber and subscriber ID not found (33)",
    );
    const payload = JSON.parse(String(audit()!.values.find((v) => typeof v === "string" && v.includes("\"source\""))));
    expect(payload).toMatchObject({ from: "submitted", to: "ready_to_submit", source: "clearinghouse", event: "rejected", submissionId: SUBMISSION });
  });
});

describe("a claim Pallio sent", () => {
  const sent = { kind: "clearinghouse" as const, event: "sent" as const, submissionId: SUBMISSION, vendorName: "Availity", filename: "pallio-837p-000000078.txt" };

  it("names the clearinghouse and the file on its history", async () => {
    currentStatus = "ready_to_submit";
    await markStatus({ orgId: ORG, id: SB, to: "submitted", actorUserId: ACTOR, source: sent });
    expect(trail()!.values).toContain("Sent to Availity in pallio-837p-000000078.txt");
    expect(calls.some((c) => c.sql.includes("submitted_at = now()"))).toBe(true);
  });

  it("a corrected denial reads as a resubmission", async () => {
    currentStatus = "denied";
    await markStatus({ orgId: ORG, id: SB, to: "submitted", source: sent });
    expect(trail()!.values).toContain("resubmitted");
    expect(trail()!.values).toContain("Resubmitted after correction: sent to Availity in pallio-837p-000000078.txt");
  });

  it("records the override given before sending, and a gap with none, without refusing (the file has gone)", async () => {
    currentStatus = "ready_to_submit";
    // The payer's standard asks for a chief complaint the note does not have
    // (the same facts mark-status.spec's documentation gate uses).
    docFacts = {
      is_telehealth: false, telehealth_modality: null, total_minutes: 45, dx_count: 1,
      dos: new Date("2026-09-09T00:00:00Z"), state: "OH", payer_id: "a0000000-0000-4000-8000-000000000302",
      payer_name: "UnitedHealthcare Community Plan Ohio", codes: ["99349"],
      filled_keys: ["hpi", "physical_exam", "assessment_and_plan"],
      template_keys: ["chief_complaint", "hpi", "vitals", "physical_exam", "assessment_and_plan"], has_vitals: true,
    };
    docReqs = [{ code: "99349", required_chart_elements: ["vitals", "chief_complaint", "physical_exam", "diagnosis", "plan", "telehealth_modality"] }];
    await markStatus({ orgId: ORG, id: SB, to: "submitted", source: sent, documentationOverride: { reason: "HPI is in the addendum of 10-28" } });
    const withReason = String(trail()!.values.find((v) => typeof v === "string" && v.startsWith("Sent to")));
    expect(withReason).toMatch(/over a documentation gap .*: HPI is in the addendum of 10-28/);
    calls = [];
    await markStatus({ orgId: ORG, id: SB, to: "submitted", source: sent });
    const noReason = String(trail()!.values.find((v) => typeof v === "string" && v.startsWith("Sent to")));
    expect(noReason).toMatch(/with a documentation gap/);
  });
});

describe("while its file is uploading", () => {
  it("a person can neither move it nor edit it", async () => {
    sending = true;
    currentStatus = "ready_to_submit";
    await expect(markStatus({ orgId: ORG, id: SB, to: "draft", actorUserId: ACTOR })).rejects.toThrow(/being sent to the clearinghouse right now/);
    await expect(updateSuperbill({ orgId: ORG, id: SB, userId: ACTOR, patch: { modifiers: ["25"] } })).rejects.toThrow(/being sent/);
    expect(calls.some((c) => c.sql.includes("UPDATE superbill"))).toBe(false);
  });

  it("CONTROL: the clearinghouse's own move is not held, and nothing is held once the upload ends", async () => {
    sending = true;
    currentStatus = "ready_to_submit";
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted", source: { kind: "clearinghouse", event: "sent", submissionId: SUBMISSION, vendorName: "Availity", filename: "f" } })).resolves.toEqual({ from: "ready_to_submit", to: "submitted" });
    sending = false;
    currentStatus = "ready_to_submit";
    await expect(markStatus({ orgId: ORG, id: SB, to: "draft", actorUserId: ACTOR })).resolves.toEqual({ from: "ready_to_submit", to: "draft" });
  });

  it("asks about this org and this claim, and only uploads begun in the last ten minutes", async () => {
    await assertNotSending(fakeTx() as never, ORG, SB);
    const q = calls.find((c) => c.sql.includes("send_state = 'sending'"))!;
    expect(q.values).toEqual([ORG, SB]);
    expect(q.sql).toContain("interval '10 minutes'");
  });
});
