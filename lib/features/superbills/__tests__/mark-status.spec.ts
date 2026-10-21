/**
 * markStatus transition-map tests (the wiring of the previously-dead
 * superbill lifecycle: draft → ready_to_submit → submitted →
 * paid | partially_paid | denied | voided, denied → submitted refiles).
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { DocumentationIncompleteError } from "@/lib/features/visits/documentation-check";

import { markStatus } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

const VISIT = "e0000000-0000-4000-8000-00000000000c";

let currentStatus: string;
/** The claim rendering-provider NPI the locked row carries. */
let currentNpi: string | null;
/** What the claim billed — the bound on a payment a person types. */
let currentBilled: number;
/** What the claim has already been paid — the partial a later write must not add to. */
let currentPaid: number;
/** What the documentation gate reads for this claim; null = no row (audit R19). */
let docFacts: Record<string, unknown> | null;
let docReqs: { code: string; required_chart_elements: string[] }[];
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT status, provider_npi, visit_id FROM superbill")) {
      return Promise.resolve(
        currentStatus ? [{ status: currentStatus, provider_npi: currentNpi, visit_id: VISIT }] : [],
      );
    }
    // BIGINT, as Prisma hands it back, so the service is held to converting it.
    if (sql.includes("SELECT billed_amount_cents FROM superbill")) {
      return Promise.resolve([{ billed_amount_cents: BigInt(currentBilled) }]);
    }
    // ANY read of paid_amount_cents answers with the partial already recorded,
    // under the column's own name and under the alias such a read usually
    // takes. The fallthrough below returns [] for an unrecognised SELECT, so a
    // write that read the column back and added to it saw prior = 0 and wrote
    // the very number a replacing write writes: the double-posting regression
    // this file exists to catch passed, in JS, with the SQL naming the column
    // once.
    if (/SELECT[\s\S]*paid_amount_cents/i.test(sql)) {
      return Promise.resolve([
        { paid_amount_cents: BigInt(currentPaid), prior: BigInt(currentPaid) },
      ]);
    }
    // The payer documentation gate's two reads (audit R19).
    if (sql.includes("FROM superbill sb")) return Promise.resolve(docFacts ? [docFacts] : []);
    if (sql.includes("FROM documentation_requirement")) return Promise.resolve(docReqs);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  currentStatus = "submitted";
  currentNpi = "1234567893";
  // $200.00 — above every amount the other cases record, so only the tests
  // about the bound have to think about it.
  currentBilled = 20000;
  // $100.00 already collected on the claim, so a write that reads the column
  // back writes a different number from one that replaces it.
  currentPaid = 10000;
  docFacts = null;
  docReqs = [];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("markStatus", () => {
  it("submitted → paid stamps paid_at + amount", async () => {
    const r = await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 12345 });
    expect(r).toEqual({ from: "submitted", to: "paid" });
    const upd = calls.find((c) => c.sql.includes("paid_at"));
    expect(upd).toBeDefined();
    expect(upd!.values).toContain(12345);
  });

  it("ready_to_submit → submitted stamps submitted_at", async () => {
    currentStatus = "ready_to_submit";
    await markStatus({ orgId: ORG, id: SB, to: "submitted" });
    expect(calls.some((c) => c.sql.includes("submitted_at"))).toBe(true);
  });

  it("denied → submitted (refile) is legal", async () => {
    currentStatus = "denied";
    const r = await markStatus({ orgId: ORG, id: SB, to: "submitted" });
    expect(r.from).toBe("denied");
  });

  it("rejects illegal moves (paid is terminal; draft can't go straight to paid)", async () => {
    currentStatus = "paid";
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow(/Illegal superbill transition/);
    currentStatus = "draft";
    await expect(markStatus({ orgId: ORG, id: SB, to: "paid" })).rejects.toThrow(/Illegal superbill transition/);
  });

  it("404s a missing superbill instead of silently no-oping", async () => {
    currentStatus = "";
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow(/not found/i);
  });

  // Client walkthrough [06:12] — the trail must record every step so an appeal
  // can show "this was the bill, it was rejected, this is the new one".
  describe("activity trail", () => {
    it("records a status_change with from/to and the actor", async () => {
      currentStatus = "ready_to_submit";
      await markStatus({ orgId: ORG, id: SB, to: "submitted", actorUserId: ACTOR });
      const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"));
      expect(act).toBeDefined();
      expect(act!.values).toContain(ACTOR);
      expect(act!.values).toContain("ready_to_submit");
      expect(act!.values).toContain("submitted");
      expect(act!.values).toContain("status_change");
      // Recorded voice (audit R35): Pallio does not send the claim.
      expect(act!.values).toContain("Recorded as submitted to the payer");
    });

    it("labels a denied → submitted move as a RESUBMISSION, not a plain status change", async () => {
      currentStatus = "denied";
      await markStatus({ orgId: ORG, id: SB, to: "submitted", actorUserId: ACTOR });
      const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"));
      expect(act!.values).toContain("resubmitted");
      expect(act!.values).toContain("Recorded as resubmitted to the payer after correction");
    });

    it("carries the paid amount into the trail entry", async () => {
      currentStatus = "submitted";
      await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 15000 });
      const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"));
      expect(act!.values).toContain("Recorded as paid in full — $150.00");
      expect(act!.values.some((v) => String(v).includes('"paidAmountCents":15000'))).toBe(true);
    });

    it("writes no trail entry when the transition is rejected", async () => {
      currentStatus = "paid";
      await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow();
      expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
    });
  });

  // Nothing used to move a visit out of pending_billing, so the claims queue
  // never drained and kept listing visits whose claims had already been paid.
  describe("closing out the visit", () => {
    it("marks the visit billed when the claim is submitted", async () => {
      currentStatus = "ready_to_submit";
      await markStatus({ orgId: ORG, id: SB, to: "submitted" });
      const upd = calls.find((c) => c.sql.includes("UPDATE visit SET status = 'billed'"));
      expect(upd).toBeDefined();
      // Guarded, so a refile can't re-fire on an already-billed visit.
      expect(upd!.sql).toContain("status = 'pending_billing'");
    });

    it("leaves the visit alone for every other transition", async () => {
      currentStatus = "submitted";
      await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 15000 });
      expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);

      calls = [];
      currentStatus = "submitted";
      await markStatus({ orgId: ORG, id: SB, to: "denied" });
      expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);
    });
  });
});

describe("markStatus → submitted: rendering NPI (audit R40)", () => {
  // A claim with no rendering-provider NPI is rejected by every payer, so it
  // must not leave Pallio marked as submitted.
  it("refuses to submit a claim with no rendering-provider NPI, and writes nothing", async () => {
    currentStatus = "ready_to_submit";
    currentNpi = "";
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow(
      /rendering-provider NPI/i,
    );
    expect(calls.some((c) => c.sql.includes("SET status = 'submitted'"))).toBe(false);
  });

  it("treats a null NPI the same as a blank one", async () => {
    currentStatus = "ready_to_submit";
    currentNpi = null;
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow(
      /rendering-provider NPI/i,
    );
  });

  it("refuses a denied claim going back out with no NPI too", async () => {
    currentStatus = "denied";
    currentNpi = "   ";
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow(
      /rendering-provider NPI/i,
    );
  });

  it("CONTROL — submits once the claim carries an NPI", async () => {
    currentStatus = "ready_to_submit";
    currentNpi = "1234567893";
    const r = await markStatus({ orgId: ORG, id: SB, to: "submitted" });
    expect(r).toEqual({ from: "ready_to_submit", to: "submitted" });
  });

  it("does not block paying or voiding a claim that lacks an NPI", async () => {
    currentStatus = "submitted";
    currentNpi = "";
    const r = await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 100 });
    expect(r).toEqual({ from: "submitted", to: "paid" });
  });
});

describe("markStatus — the review checkpoint (audit R26)", () => {
  it("refuses draft → submitted: review cannot be skipped, and writes nothing", async () => {
    currentStatus = "draft";
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow(
      /Illegal superbill transition draft → submitted/,
    );
    expect(calls.some((c) => c.sql.includes("UPDATE superbill"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
  });

  it("records draft → ready_to_submit as reviewed, naming who, and leaves the visit alone", async () => {
    currentStatus = "draft";
    const r = await markStatus({ orgId: ORG, id: SB, to: "ready_to_submit", actorUserId: ACTOR });
    expect(r).toEqual({ from: "draft", to: "ready_to_submit" });
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(act.values).toContain(ACTOR);
    expect(act.values).toContain("Reviewed — ready to submit");
    expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);
  });

  it("records ready_to_submit → draft as sent back", async () => {
    currentStatus = "ready_to_submit";
    await markStatus({ orgId: ORG, id: SB, to: "draft" });
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(act.values).toContain("Sent back to draft");
  });
});

const UHC_FACTS = {
  is_telehealth: false, telehealth_modality: null, total_minutes: 45, dx_count: 1,
  dos: new Date("2026-09-09T00:00:00Z"), state: "OH",
  payer_id: "a0000000-0000-4000-8000-000000000302",
  payer_name: "UnitedHealthcare Community Plan Ohio",
  codes: ["99349"],
  // No chief complaint: the gap the payer's manual names.
  filled_keys: ["hpi", "physical_exam", "assessment_and_plan"],
  template_keys: ["chief_complaint", "hpi", "vitals", "physical_exam", "assessment_and_plan"],
  has_vitals: true,
};
const UHC_REQ = [
  {
    code: "99349",
    required_chart_elements: ["vitals", "chief_complaint", "physical_exam", "diagnosis", "plan", "telehealth_modality"],
  },
];

describe("markStatus → submitted: the payer's documentation standard (audit R19)", () => {
  it("refuses a claim whose note lacks what the payer requires, and writes nothing", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    const err = await markStatus({ orgId: ORG, id: SB, to: "submitted" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentationIncompleteError);
    const gap = (err as DocumentationIncompleteError).gap;
    expect(gap.missing.map((m) => m.element)).toEqual(["chief_complaint"]);
    expect((err as Error).message).toContain("UnitedHealthcare Community Plan Ohio");
    expect(calls.some((c) => c.sql.includes("SET status = 'submitted'"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO audit_log"))).toBe(false);
  });

  it("reads the claim's own payer, state and date of service", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await markStatus({ orgId: ORG, id: SB, to: "submitted" }).catch(() => undefined);
    expect(calls.find((c) => c.sql.includes("FROM superbill sb"))!.values).toContain(SB);
    const req = calls.find((c) => c.sql.includes("FROM documentation_requirement"))!;
    expect(req.values).toContain("a0000000-0000-4000-8000-000000000302");
    expect(req.values).toContain("OH");
    expect(req.values).toContain("2026-09-09");
  });

  it("submits with a reason, and keeps the reason and the gap on the claim history", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    const r = await markStatus({
      orgId: ORG, id: SB, to: "submitted", actorUserId: ACTOR,
      documentationOverride: { reason: "Chief complaint is in the referral letter" },
    });
    expect(r).toEqual({ from: "ready_to_submit", to: "submitted" });
    expect(calls.some((c) => c.sql.includes("SET status = 'submitted'"))).toBe(true);
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    const detail = JSON.parse(String(act.values.find((v) => String(v).includes("documentationOverride"))));
    expect(detail.documentationOverride).toEqual({
      missing: ["chief_complaint"],
      reason: "Chief complaint is in the referral letter",
    });
    expect(act.values.some((v) => String(v).includes("over a documentation gap (Chief complaint)"))).toBe(true);
  });

  it("treats a blank reason as no reason", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "submitted", documentationOverride: { reason: "   " } }),
    ).rejects.toBeInstanceOf(DocumentationIncompleteError);
  });

  it("holds a refile to the same standard", async () => {
    currentStatus = "denied";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toBeInstanceOf(
      DocumentationIncompleteError,
    );
  });

  it("CONTROL — submits when the note documents every element", async () => {
    currentStatus = "ready_to_submit";
    docFacts = { ...UHC_FACTS, filled_keys: ["chief_complaint", "hpi", "physical_exam", "assessment_and_plan"] };
    docReqs = UHC_REQ;
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).resolves.toEqual({
      from: "ready_to_submit",
      to: "submitted",
    });
  });

  it("CONTROL — a claim with no payer is held to no payer's standard", async () => {
    currentStatus = "ready_to_submit";
    docFacts = { ...UHC_FACTS, payer_id: null };
    docReqs = UHC_REQ;
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).resolves.toBeDefined();
    expect(calls.some((c) => c.sql.includes("FROM documentation_requirement"))).toBe(false);
  });

  it("never reads the standard for moves that do not send the claim out", async () => {
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 100 });
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    currentStatus = "draft";
    await markStatus({ orgId: ORG, id: SB, to: "ready_to_submit" });
    expect(calls.some((c) => c.sql.includes("FROM superbill sb"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("FROM documentation_requirement"))).toBe(false);
  });
});

describe("markStatus — the audit log (audit R24)", () => {
  const auditRow = () => calls.find((c) => c.sql.includes("INSERT INTO audit_log"));
  const auditPayload = () =>
    JSON.parse(String(auditRow()!.values.find((v) => String(v).startsWith("{"))));

  it("writes superbill_status_change with from, to, the actor and the visit", async () => {
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 15000, actorUserId: ACTOR });
    const row = auditRow()!;
    expect(row.values).toContain("superbill_status_change");
    expect(row.values).toContain("superbill");
    expect(row.values).toContain(ACTOR);
    expect(row.values).toContain(SB);
    expect(auditPayload()).toEqual({ from: "submitted", to: "paid", visitId: VISIT, paidAmountCents: 15000 });
  });

  it("records a documentation override as element keys, never the free-text reason", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await markStatus({
      orgId: ORG, id: SB, to: "submitted",
      documentationOverride: { reason: "Stephen told the nurse at the door" },
    });
    expect(auditPayload().documentationOverride).toEqual(["chief_complaint"]);
    expect(JSON.stringify(auditRow()!.values)).not.toContain("Stephen");
  });

  it("writes nothing when the transition is refused", async () => {
    currentStatus = "paid";
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toThrow();
    expect(auditRow()).toBeUndefined();
  });
});

describe("markStatus — the trail in the recorded voice (audit R35)", () => {
  // Pallio sends no claim, so a status move is the org recording what it did
  // or heard elsewhere. The summary is the one value in the trail insert with
  // a space in it: ids, kind and statuses have none, and the detail is JSON.
  const trailSummary = () => {
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    return act.values.find(
      (v): v is string => typeof v === "string" && v.includes(" ") && !v.startsWith("{"),
    );
  };
  const OLD_WORDING =
    /^(Submitted to the payer|Resubmitted to the payer|Denied by the payer|Paid in full|Partially paid)/;

  // draft → submitted has been illegal since the review checkpoint (R26), so
  // a first submission is ready_to_submit → submitted.
  const moves: {
    from: string;
    to: "submitted" | "denied" | "paid" | "partially_paid";
    paid?: number;
    expected: string;
  }[] = [
    { from: "ready_to_submit", to: "submitted", expected: "Recorded as submitted to the payer" },
    { from: "denied", to: "submitted", expected: "Recorded as resubmitted to the payer after correction" },
    { from: "submitted", to: "denied", expected: "Recorded as denied by the payer" },
    { from: "submitted", to: "paid", paid: 15000, expected: "Recorded as paid in full — $150.00" },
    { from: "submitted", to: "partially_paid", paid: 5000, expected: "Recorded as partially paid — $50.00" },
  ];
  const run = (m: (typeof moves)[number]) =>
    markStatus({
      orgId: ORG, id: SB, to: m.to,
      ...(m.paid !== undefined ? { paidAmountCents: m.paid } : {}),
    });

  for (const m of moves) {
    it(`${m.from} → ${m.to} reads "${m.expected}"`, async () => {
      currentStatus = m.from;
      await run(m);
      expect(trailSummary()).toBe(m.expected);
    });
  }

  it("CONTROL — none of those moves writes the old payer-event wording", async () => {
    for (const m of moves) {
      calls = [];
      currentStatus = m.from;
      await run(m);
      const s = trailSummary()!;
      expect(s).toMatch(/^Recorded as /);
      expect(s).not.toMatch(OLD_WORDING);
    }
  });

  it("keeps R19's documentation-override suffix after the recorded wording", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await markStatus({
      orgId: ORG, id: SB, to: "submitted",
      documentationOverride: { reason: "Chief complaint is in the referral letter" },
    });
    expect(trailSummary()).toBe(
      "Recorded as submitted to the payer — over a documentation gap (Chief complaint): Chief complaint is in the referral letter",
    );
  });
});

describe("markStatus from a payer's 835 (audit R10)", () => {
  // Remittance posting runs every move through markStatusTx with a source:
  // the payer's own word, cited on the trail, and read against the
  // documentation gate without being stopped by it.
  const SOURCE = {
    kind: "remittance" as const,
    remittanceFileId: "44444444-4444-4444-8444-444444444444",
    traceNumber: "LOCAL-PAY-1",
  };
  const trailSummary = () => {
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    return act.values.find(
      (v): v is string => typeof v === "string" && v.includes(" ") && !v.startsWith("{"),
    );
  };
  const json = (frag: string) => {
    const c = calls.find((x) => x.sql.includes(frag))!;
    return JSON.parse(String(c.values.find((v) => String(v).startsWith("{"))));
  };

  it("records paid_source 'remittance' and the payer's word on the trail", async () => {
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 9850, source: SOURCE });
    const upd = calls.find((c) => c.sql.includes("paid_at"))!;
    expect(upd.sql).toContain("paid_source");
    expect(upd.values).toContain("remittance");
    expect(trailSummary()).toBe("Paid — $98.50, per payer remittance LOCAL-PAY-1");
  });

  it("CONTROL — a payment typed from the queue records paid_source 'recorded'", async () => {
    currentStatus = "submitted";
    // As the queue posts it: every paid it sends claims the whole bill
    // (paidInFull), so the claim bills what was typed.
    currentBilled = 9850;
    await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 9850, paidInFull: true });
    const upd = calls.find((c) => c.sql.includes("paid_at"))!;
    expect(upd.values).toContain("recorded");
    expect(upd.values).not.toContain("remittance");
    expect(trailSummary()).toBe("Recorded as paid in full — $98.50");
  });

  it("makes no UNCODED denial for a denial from the file, which carries its own reason", async () => {
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: SB, to: "denied", source: SOURCE });
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_denial"))).toBe(false);
    expect(trailSummary()).toBe("Denied by the payer, per remittance LOCAL-PAY-1");
  });

  it("CONTROL — a denial recorded from the queue still makes its UNCODED row", async () => {
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(calls.find((c) => c.sql.includes("INSERT INTO superbill_denial"))!.sql).toContain("'UNCODED'");
  });

  it("reads the payer documentation gate (R19) but does not stop a remittance: the payer has already processed the claim", async () => {
    // Changed on purpose (review finding): the gate used to be skipped, and a
    // gap on a claim the payer processed went unrecorded.
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    const r = await markStatus({ orgId: ORG, id: SB, to: "submitted", source: SOURCE });
    expect(r).toEqual({ from: "ready_to_submit", to: "submitted" });
    expect(calls.some((c) => c.sql.includes("SET status = 'submitted'"))).toBe(true);
    expect(trailSummary()).toBe(
      "Submission confirmed by payer remittance LOCAL-PAY-1 — with a documentation gap (Chief complaint)",
    );
  });

  it("keeps the gap as element names on the trail detail and in the audit row", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await markStatus({ orgId: ORG, id: SB, to: "submitted", actorUserId: ACTOR, source: SOURCE });
    expect(json("INSERT INTO superbill_activity")).toEqual({
      documentationGap: ["chief_complaint"], source: "remittance", remittanceFileId: SOURCE.remittanceFileId,
    });
    expect(json("INSERT INTO audit_log")).toEqual({
      from: "ready_to_submit", to: "submitted", visitId: VISIT,
      documentationGap: ["chief_complaint"], source: "remittance", remittanceFileId: SOURCE.remittanceFileId,
    });
  });

  it("CONTROL — a remittance step with the note complete records no gap", async () => {
    currentStatus = "ready_to_submit";
    docFacts = { ...UHC_FACTS, filled_keys: ["chief_complaint", "hpi", "physical_exam", "assessment_and_plan"] };
    docReqs = UHC_REQ;
    await markStatus({ orgId: ORG, id: SB, to: "submitted", source: SOURCE });
    expect(json("INSERT INTO superbill_activity")).not.toHaveProperty("documentationGap");
    expect(json("INSERT INTO audit_log")).not.toHaveProperty("documentationGap");
    expect(trailSummary()).toBe("Submission confirmed by payer remittance LOCAL-PAY-1");
  });

  it("CONTROL — a person's refile over the same gap still throws DocumentationIncompleteError, and writes nothing", async () => {
    currentStatus = "denied";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toBeInstanceOf(
      DocumentationIncompleteError,
    );
    expect(calls.some((c) => c.sql.includes("UPDATE superbill"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO audit_log"))).toBe(false);
  });

  it("CONTROL — the same claim typed as submitted is still stopped by the gate", async () => {
    currentStatus = "ready_to_submit";
    docFacts = UHC_FACTS;
    docReqs = UHC_REQ;
    await expect(markStatus({ orgId: ORG, id: SB, to: "submitted" })).rejects.toBeInstanceOf(
      DocumentationIncompleteError,
    );
  });

  it("keeps the transition map (R26) and the rendering-NPI check (R40) for a remittance", async () => {
    currentStatus = "draft";
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "submitted", source: SOURCE }),
    ).rejects.toThrow(/Illegal superbill transition draft → submitted/);
    currentStatus = "denied";
    currentNpi = "";
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "submitted", source: SOURCE }),
    ).rejects.toThrow(/rendering-provider NPI/);
    expect(calls.some((c) => c.sql.includes("UPDATE superbill"))).toBe(false);
  });

  it("names the remittance on the trail detail and in the audit row (R24)", async () => {
    currentStatus = "submitted";
    await markStatus({
      orgId: ORG, id: SB, to: "paid", paidAmountCents: 9850, actorUserId: ACTOR, source: SOURCE,
    });
    expect(json("INSERT INTO superbill_activity")).toEqual({
      paidAmountCents: 9850, source: "remittance", remittanceFileId: SOURCE.remittanceFileId,
    });
    expect(json("INSERT INTO audit_log")).toEqual({
      from: "submitted", to: "paid", visitId: VISIT, paidAmountCents: 9850,
      source: "remittance", remittanceFileId: SOURCE.remittanceFileId,
    });
  });

  it("markStatusTx runs in the caller's transaction and opens none of its own", async () => {
    const { markStatusTx } = await import("../superbill.service");
    vi.mocked(withOrgContext).mockClear();
    currentStatus = "submitted";
    const r = await markStatusTx(fakeTx() as never, {
      orgId: ORG, id: SB, to: "paid", paidAmountCents: 9850, source: SOURCE,
    });
    expect(r).toEqual({ from: "submitted", to: "paid" });
    expect(vi.mocked(withOrgContext)).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("paid_source"))).toBe(true);
  });
});

describe("markStatus — a recorded payment is bounded by what the claim billed", () => {
  // The bound the queue's "Record partial payment" never had: it parsed the
  // prompt with a bare Number() and only rejected non-finite/negative, the
  // route capped at an absolute $1,000,000, and nothing compared either to the
  // claim. A cents/dollars slip — 5000 typed for $50.00 on a $150.00 claim —
  // wrote $5,000.00 and left /billing reporting $5,000 collected against $150
  // billed, Outstanding negative.
  const trailSummary = () => {
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    return act.values.find(
      (v): v is string => typeof v === "string" && v.includes(" ") && !v.startsWith("{"),
    );
  };
  const json = (frag: string) => {
    const c = calls.find((x) => x.sql.includes(frag))!;
    return JSON.parse(String(c.values.find((v) => String(v).startsWith("{"))));
  };
  const SOURCE = {
    kind: "remittance" as const,
    remittanceFileId: "44444444-4444-4444-8444-444444444444",
    traceNumber: "LOCAL-PAY-1",
  };

  it("refuses $5000.00 typed on a $150.00 claim, and writes nothing", async () => {
    currentStatus = "submitted";
    currentBilled = 15000;
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "partially_paid", paidAmountCents: 500000 }),
    ).rejects.toThrow(/billed/);
    expect(calls.some((c) => c.sql.includes("paid_at"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO audit_log"))).toBe(false);
  });

  it("names both figures and the format, so the biller can see the slip", async () => {
    currentStatus = "submitted";
    currentBilled = 15000;
    const err = await markStatus({
      orgId: ORG, id: SB, to: "partially_paid", paidAmountCents: 500000,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("$5000.00");
    expect((err as Error).message).toContain("$150.00");
    expect((err as Error).message).toContain("50.00, not 5000");
  });

  it("holds a paid-in-full move to the same bound", async () => {
    currentStatus = "partially_paid";
    currentBilled = 15000;
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 20000 }),
    ).rejects.toThrow(/billed/);
  });

  it("tells nobody to re-type an amount nobody typed", async () => {
    // "Record paid in full" posts the queue row's own billed figure, and that
    // row goes stale: repriceSuperbill rewrites billed_amount_cents on a
    // draft, ready-to-submit or denied claim, so a claim repriced downward in
    // one tab is refused in another with an amount the biller never entered.
    currentStatus = "partially_paid";
    currentBilled = 15000;
    const err = await markStatus({
      orgId: ORG, id: SB, to: "paid", paidAmountCents: 20000,
    }).catch((e: unknown) => e);
    expect((err as Error).message).not.toMatch(/\bEnter the amount\b/i);
    expect((err as Error).message).toContain("Amounts are recorded in dollars and cents");
  });

  it("refuses an acknowledged overpayment recorded as PARTIALLY paid, and writes nothing", async () => {
    // A payment above the bill is not a partial payment. Recorded as one it
    // wrote a trail line contradicting itself, sat in the queue's "partially
    // paid" filter, and counted into /billing's Outstanding.
    currentStatus = "submitted";
    currentBilled = 15000;
    const err = await markStatus({
      orgId: ORG, id: SB, to: "partially_paid", paidAmountCents: 500000,
      overpaymentAcknowledged: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("not a partial payment");
    expect((err as Error).message).toContain("$5000.00");
    expect((err as Error).message).toContain("$150.00");
    expect(calls.some((c) => c.sql.includes("paid_at"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO audit_log"))).toBe(false);
  });

  it("CONTROL — the same acknowledged overpayment recorded as paid goes through, and says so once", async () => {
    currentStatus = "submitted";
    currentBilled = 15000;
    await expect(
      markStatus({
        orgId: ORG, id: SB, to: "paid", paidAmountCents: 500000, overpaymentAcknowledged: true,
      }),
    ).resolves.toEqual({ from: "submitted", to: "paid" });
    const line = trailSummary()!;
    expect(line).toBe(
      "Recorded as paid in full — $5000.00 — more than the $150.00 billed, confirmed as an overpayment",
    );
    // No trail line says a payment is both partial and above the bill.
    expect(line).not.toContain("partially paid");
  });

  it("records it once the caller confirms the overpayment, saying so on the trail and in the audit row", async () => {
    // Payers do pay more than billed (a duplicate payment, prompt-pay
    // interest), so the amount stays recordable — but never silently.
    currentStatus = "submitted";
    currentBilled = 15000;
    const r = await markStatus({
      orgId: ORG, id: SB, to: "paid", paidAmountCents: 16000,
      actorUserId: ACTOR, overpaymentAcknowledged: true,
    });
    expect(r).toEqual({ from: "submitted", to: "paid" });
    expect(calls.find((c) => c.sql.includes("paid_at"))!.values).toContain(16000);
    expect(trailSummary()).toBe(
      "Recorded as paid in full — $160.00 — more than the $150.00 billed, confirmed as an overpayment",
    );
    expect(json("INSERT INTO superbill_activity").overpayment).toEqual({ billedAmountCents: 15000 });
    expect(json("INSERT INTO audit_log").overpayment).toEqual({ billedAmountCents: 15000 });
  });

  it("CONTROL — a payment at or under the billed amount needs no confirmation and is labelled nothing", async () => {
    for (const cents of [15000, 5000]) {
      calls = [];
      currentStatus = "submitted";
      currentBilled = 15000;
      await expect(
        markStatus({ orgId: ORG, id: SB, to: "partially_paid", paidAmountCents: cents }),
      ).resolves.toEqual({ from: "submitted", to: "partially_paid" });
      expect(trailSummary()).not.toContain("overpayment");
      expect(json("INSERT INTO superbill_activity")).not.toHaveProperty("overpayment");
      expect(json("INSERT INTO audit_log")).not.toHaveProperty("overpayment");
    }
  });

  it("does not bound an amount posted from a payer's 835 (audit R10): that figure is the payer's own word", async () => {
    currentStatus = "submitted";
    currentBilled = 15000;
    const r = await markStatus({
      orgId: ORG, id: SB, to: "paid", paidAmountCents: 500000, source: SOURCE,
    });
    expect(r).toEqual({ from: "submitted", to: "paid" });
    expect(json("INSERT INTO superbill_activity")).not.toHaveProperty("overpayment");
  });

  it("does not bound an unpriced claim: billed 0 is nothing to compare against", async () => {
    currentStatus = "submitted";
    currentBilled = 0;
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "partially_paid", paidAmountCents: 500000 }),
    ).resolves.toEqual({ from: "submitted", to: "partially_paid" });
  });

  it("never reads the billed amount for a move that records no money", async () => {
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    currentStatus = "draft";
    await markStatus({ orgId: ORG, id: SB, to: "ready_to_submit" });
    expect(calls.some((c) => c.sql.includes("SELECT billed_amount_cents"))).toBe(false);
  });
});

describe("partially_paid → paid — the one move a partly paid claim offers", () => {
  // The queue offers exactly this button on a partially paid claim
  // (superbill-queue.ts), and nothing ever executed it: two specs check the
  // button exists and names a legal move, so a change making the write ADD to
  // the partial already recorded — a $150 claim reporting $200 collected —
  // would have passed both.
  const paidUpdate = () => calls.find((c) => c.sql.includes("paid_at"))!;
  /** How often an UPDATE touches paid_amount_cents; 1 = replaced, 2 = added to. */
  const mentionsPaidAmount = (sql: string) => (sql.match(/paid_amount_cents/g) ?? []).length;
  const trailSummary = () => {
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    return act.values.find(
      (v): v is string => typeof v === "string" && v.includes(" ") && !v.startsWith("{"),
    );
  };

  it("runs the transition and writes the new amount as the total, not on top of the partial", async () => {
    currentStatus = "partially_paid";
    currentBilled = 15000;
    currentPaid = 10000; // $100.00 of the $150.00 already collected
    const r = await markStatus({
      orgId: ORG, id: SB, to: "paid", paidAmountCents: 15000, actorUserId: ACTOR,
    });
    expect(r).toEqual({ from: "partially_paid", to: "paid" });
    // The teeth: paid_amount_cents is the total the payer has paid, so the
    // only figure this UPDATE writes is the one the caller posted. A write
    // that reads the $100.00 partial back and adds to it writes 25000 — in
    // SQL, or in JS from a SELECT the fake now answers.
    expect(paidUpdate().values.filter((v) => typeof v === "number")).toEqual([15000]);
    // And the column is assigned once, never read back into its own sum.
    expect(mentionsPaidAmount(paidUpdate().sql)).toBe(1);
    expect(paidUpdate().values).toContain("recorded");
  });

  it("records the move from partially_paid on the trail and in the audit row", async () => {
    currentStatus = "partially_paid";
    currentBilled = 15000;
    await markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 15000, actorUserId: ACTOR });
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(act.values).toContain("partially_paid");
    expect(act.values).toContain("paid");
    expect(act.values).toContain(ACTOR);
    expect(trailSummary()).toBe("Recorded as paid in full — $150.00");
    const audit = calls.find((c) => c.sql.includes("INSERT INTO audit_log"))!;
    expect(JSON.parse(String(audit.values.find((v) => String(v).startsWith("{"))))).toEqual({
      from: "partially_paid", to: "paid", visitId: VISIT, paidAmountCents: 15000,
    });
  });

  it("CONTROL — that count catches an UPDATE that adds to the partial already recorded", () => {
    // The SQL-shaped half only: an accumulating write names the column twice.
    // The same accumulation written in JS names it once, which is why the test
    // above asserts the figure written and not just this count.
    expect(
      mentionsPaidAmount("UPDATE superbill SET¶ paid_amount_cents = COALESCE(paid_amount_cents, 0) + ¶,"),
    ).toBe(2);
  });

  it("CONTROL — the fake answers a paid-amount read, so a JS accumulation cannot read 0", async () => {
    // Why the assertion above has teeth against the JS shape: the prior the
    // service would find is $100.00, not the 0 an unanswered SELECT gave it.
    currentPaid = 10000;
    const rows = (await fakeTx().$queryRaw`
      SELECT COALESCE(paid_amount_cents, 0) AS prior FROM superbill WHERE id = ${SB}::uuid
    `) as { prior: bigint }[];
    expect(Number(rows[0]!.prior)).toBe(10000);
  });
});

describe("markStatus — a payment recorded as IN FULL is checked against the claim", () => {
  // The queue decides "this covers the bill" from its own fetched row: "Record
  // paid in full" posts that row's billed figure, and a typed amount that
  // reaches it is posted as paid rather than partial. The row goes stale in
  // both directions — updateSuperbill lets a denied claim be edited and
  // repriced UP (repriceSuperbill) and resubmitted in another tab — and the
  // high direction was already bounded here while the LOW one was not: an
  // amount covering the older, smaller figure wrote status 'paid' on a claim
  // billing more. STATUS_TRANSITIONS.paid is [], so the rest of that payment
  // could never be recorded, under a trail line saying it was paid in full.
  // Nothing under app/ is tested, so the assertion is checked on the one side
  // that holds the real figure.
  const trailSummary = () => {
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    return act.values.find(
      (v): v is string => typeof v === "string" && v.includes(" ") && !v.startsWith("{"),
    );
  };
  const wroteNothing = () => ({
    payment: calls.some((c) => c.sql.includes("paid_at")),
    trail: calls.some((c) => c.sql.includes("INSERT INTO superbill_activity")),
    audit: calls.some((c) => c.sql.includes("INSERT INTO audit_log")),
  });

  it("refuses $200.00 recorded as paid in full on a claim billing $250.00, and writes nothing", async () => {
    currentStatus = "submitted";
    currentBilled = 25000; // repriced up in another tab; the queue row still says $200.00
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 20000, paidInFull: true }),
    ).rejects.toThrow(/paid in full/);
    expect(wroteNothing()).toEqual({ payment: false, trail: false, audit: false });
  });

  it("names both figures, what would be left, and that paid is final", async () => {
    currentStatus = "submitted";
    currentBilled = 25000;
    const err = await markStatus({
      orgId: ORG, id: SB, to: "paid", paidAmountCents: 20000, paidInFull: true,
    }).catch((e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toContain("$200.00");
    expect(message).toContain("$250.00");
    expect(message).toContain("$50.00");
    expect(message).toContain("final status");
    // Nobody typed $200.00 as an amount to correct — "Record paid in full"
    // posts the row's own figure — so the fix offered is reloading, not
    // re-typing (the same lesson as the overpayment message above).
    expect(message).toMatch(/reload the queue/i);
  });

  it("CONTROL — the same short payment recorded WITHOUT that claim goes through", async () => {
    // A payment under the bill is ordinary: a contractual adjustment closes
    // most claims for less than they billed, and today's only such row came
    // from an 835. What is refused is the assertion, never the amount.
    currentStatus = "submitted";
    currentBilled = 25000;
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 20000 }),
    ).resolves.toEqual({ from: "submitted", to: "paid" });
    expect(calls.find((c) => c.sql.includes("paid_at"))!.values).toContain(20000);
  });

  it("records it when the amount does cover the bill", async () => {
    currentStatus = "submitted";
    currentBilled = 20000;
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 20000, paidInFull: true }),
    ).resolves.toEqual({ from: "submitted", to: "paid" });
    expect(trailSummary()).toBe("Recorded as paid in full — $200.00");
  });

  it("lets a confirmed overpayment through: more than the bill still covers it", async () => {
    currentStatus = "submitted";
    currentBilled = 15000;
    await expect(
      markStatus({
        orgId: ORG, id: SB, to: "paid", paidAmountCents: 16000,
        paidInFull: true, overpaymentAcknowledged: true,
      }),
    ).resolves.toEqual({ from: "submitted", to: "paid" });
    expect(trailSummary()).toBe(
      "Recorded as paid in full — $160.00 — more than the $150.00 billed, confirmed as an overpayment",
    );
  });

  it("holds an unpriced claim to nothing: billed 0 is not a bill to cover", async () => {
    currentStatus = "submitted";
    currentBilled = 0;
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "paid", paidAmountCents: 5000, paidInFull: true }),
    ).resolves.toEqual({ from: "submitted", to: "paid" });
  });

  it("CONTROL — an amount posted from a payer's 835 is never held to the claim (audit R10)", async () => {
    // Same rule as the overpayment bound: the payer's own figure is not
    // refused. This pins the check inside that same no-source block.
    currentStatus = "submitted";
    currentBilled = 25000;
    await expect(
      markStatus({
        orgId: ORG, id: SB, to: "paid", paidAmountCents: 20000, paidInFull: true,
        source: {
          kind: "remittance",
          remittanceFileId: "44444444-4444-4444-8444-444444444444",
          traceNumber: "LOCAL-PAY-1",
        },
      }),
    ).resolves.toEqual({ from: "submitted", to: "paid" });
  });
});
