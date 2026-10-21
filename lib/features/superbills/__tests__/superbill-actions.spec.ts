/**
 * The queue's one-click actions, held to the recorded voice and to the
 * service's transition map (audit R35, R26).
 *
 * The buttons live in a client-safe module (superbill-queue.ts) and the legal
 * moves in the service, which that module cannot import. Nothing but this spec
 * keeps them in step: a relabelled button pointing at an illegal move would
 * only surface as a 422 in front of a biller. lib/db is mocked with the same
 * SQL-dispatching fake as mark-status.spec.ts, so every button is also RUN
 * through the service from the button list itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { QUEUE_ACTIONS, SUBMISSION_DISCLOSURE } from "../superbill-queue";
import {
  STATUS_TRANSITIONS,
  SUPERBILL_STATUSES,
  markStatus,
  type SuperbillStatus,
} from "../superbill.service";

const actions = Object.entries(QUEUE_ACTIONS).flatMap(([from, list]) =>
  list.map((a) => ({ from, ...a })),
);

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
/** $150.00 — what the claim under test billed, and so what "paid in full" posts. */
const BILLED = 15000;

let currentStatus: string;
let calls: { sql: string; values: unknown[] }[] = [];

/** The same SQL-dispatching fake as mark-status.spec.ts, cut to what a button hits. */
function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT status, provider_npi, visit_id FROM superbill")) {
      return Promise.resolve([
        { status: currentStatus, provider_npi: "1234567893", visit_id: VISIT },
      ]);
    }
    if (sql.includes("SELECT billed_amount_cents FROM superbill")) {
      return Promise.resolve([{ billed_amount_cents: BigInt(BILLED) }]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("QUEUE_ACTIONS — the recorded voice (audit R35)", () => {
  it("every label starts with 'Record ': Pallio records what happened elsewhere", () => {
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.label).toMatch(/^Record /);
  });

  it("no label reads as the click itself sending, paying or denying the claim", () => {
    for (const a of actions) {
      expect(a.label).not.toMatch(/^(Mark|Submit|Resubmitted|Paid|Partially|Denied)\b/);
    }
  });
});

describe("QUEUE_ACTIONS against STATUS_TRANSITIONS", () => {
  it("offers buttons only for real statuses", () => {
    for (const from of Object.keys(QUEUE_ACTIONS)) {
      expect(SUPERBILL_STATUSES as readonly string[]).toContain(from);
    }
  });

  it("every action is a legal move from its status", () => {
    for (const a of actions) {
      expect(STATUS_TRANSITIONS[a.from as SuperbillStatus]).toContain(a.to);
    }
  });

  // Whether a button's amount matches its status is pinned as a pairing of
  // constants in superbill-queue.spec.ts. What no constant can show is what
  // the button DOES: every one of them is run through the service here, from
  // the button list itself, so an action added to the queue is executed by
  // this file the day it appears.
  //
  // What the queue posts for a button: the claim's billed amount for "Record
  // paid in full", what the biller types for "Record partial payment",
  // nothing for a move that records no money.
  const postedAmount = (amount?: string) =>
    amount === undefined ? undefined : amount === "billed" ? BILLED : 5000;

  const runButton = async (a: { from: string; to: SuperbillStatus; amount?: string }) => {
    calls = [];
    currentStatus = a.from;
    const paidAmountCents = postedAmount(a.amount);
    const result = await markStatus({
      orgId: ORG,
      id: SB,
      to: a.to,
      ...(paidAmountCents !== undefined ? { paidAmountCents } : {}),
    });
    return { result, paidWrite: calls.find((c) => c.sql.includes("paid_at")), paidAmountCents };
  };

  it("every button runs its move through the service, and only the money ones stamp a payment", async () => {
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      const { result, paidWrite, paidAmountCents } = await runButton(a);
      expect([a.label, result]).toEqual([a.label, { from: a.from, to: a.to }]);
      expect([a.label, paidWrite !== undefined]).toEqual([a.label, a.amount !== undefined]);
      // The amount the button carries is the one written, whole.
      if (paidWrite) expect(paidWrite.values).toContain(paidAmountCents);
    }
  });

  it("CONTROL — a money button carrying no amount stamps a payment of nothing", async () => {
    // "Record paid in full" without its amount: the route 422s it, and the
    // service stamps paid_at with paid_amount_cents null. The pairing above
    // catches it because the write happens and the action declares none.
    const { paidWrite } = await runButton({ from: "submitted", to: "paid" });
    expect(paidWrite).toBeDefined();
    expect(paidWrite!.values).toContain(null);
  });

  it("CONTROL — a button asking for an amount on a move that records none stamps nothing", async () => {
    const { paidWrite } = await runButton({ from: "submitted", to: "denied", amount: "billed" });
    expect(paidWrite).toBeUndefined();
  });

  it("CONTROL — the check has teeth: a draft cannot move to submitted (R26)", () => {
    // Why a draft offers no "Record as submitted", though the scoping listed
    // one: the review checkpoint makes that move illegal, and a button for it
    // would fail the check above.
    expect(STATUS_TRANSITIONS.draft).not.toContain("submitted");
    expect(QUEUE_ACTIONS.draft).toEqual([]);
  });
});

describe("SUBMISSION_DISCLOSURE (audit R35)", () => {
  it("says Pallio does not send claims, where to send them, and whose figures these are", () => {
    expect(SUBMISSION_DISCLOSURE).toContain("does not send claims");
    expect(SUBMISSION_DISCLOSURE).toMatch(/clearinghouse or the payer's portal/);
    expect(SUBMISSION_DISCLOSURE).toMatch(/what your team recorded/);
  });
});
