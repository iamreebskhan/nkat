/**
 * Another payment on a partially paid claim (D9). Pallio keeps one paid figure
 * per claim, so the payment is added to it; the claim history keeps a line per
 * payment. lib/db is mocked with a fake tx answering by statement.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  calls: [] as { sql: string; values: unknown[] }[],
  bill: { status: "partially_paid", paid_amount_cents: 5000 as number | bigint | null, billed_amount_cents: 15000 as number | bigint | null, visit_id: "v" } as Record<string, unknown> | null,
  sending: false,
}));

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: async (_o: string, fn: (tx: unknown) => unknown) => {
    const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("¶");
      h.calls.push({ sql, values });
      if (sql.includes("SELECT status, paid_amount_cents, billed_amount_cents")) return Promise.resolve(h.bill ? [h.bill] : []);
      if (sql.includes("FROM claim_submission_item")) return Promise.resolve(h.sending ? [{ ok: 1 }] : []);
      return Promise.resolve(1);
    };
    return fn({ $queryRaw: run, $executeRaw: run });
  },
}));
vi.mock("@/lib/features/audit/audit-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: h.audit,
}));
vi.mock("@/lib/auth", () => ({
  requireAuth: async (perms: string[]) => {
    h.calls.push({ sql: "requireAuth", values: perms });
    return new Response(null, { status: 403 });
  },
}));

import { POST } from "@/app/api/superbills/[id]/payments/route";

import { furtherPaymentTotal } from "../superbill-queue";
import { recordFurtherPayment } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const pay = (amountCents: number, extra: { last?: boolean; overpaymentAcknowledged?: boolean } = {}) =>
  recordFurtherPayment({ orgId: ORG, id: SB, actorUserId: USER, amountCents, ...extra });
const write = () => h.calls.find((c) => c.sql.includes("UPDATE superbill SET"))!;
const trail = () => h.calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
const trailLine = () => trail().values.find((v) => typeof v === "string" && v.startsWith("Recorded")) as string;

beforeEach(() => {
  h.audit.mockReset();
  h.calls = [];
  h.bill = { status: "partially_paid", paid_amount_cents: 5000, billed_amount_cents: 15000, visit_id: "v" };
  h.sending = false;
});

describe("furtherPaymentTotal", () => {
  it("adds, and says whether the total reaches or passes the bill", () => {
    expect(furtherPaymentTotal({ paidCents: 5000, billedCents: 15000, amountCents: 2000 })).toEqual({ totalCents: 7000, above: false, covers: false });
    expect(furtherPaymentTotal({ paidCents: 5000, billedCents: 15000, amountCents: 10000 })).toEqual({ totalCents: 15000, above: false, covers: true });
    expect(furtherPaymentTotal({ paidCents: 5000, billedCents: 15000, amountCents: 10001 })).toEqual({ totalCents: 15001, above: true, covers: true });
  });

  it("an unpriced claim has no bill to reach", () => {
    expect(furtherPaymentTotal({ paidCents: 5000, billedCents: 0, amountCents: 2000 })).toEqual({ totalCents: 7000, above: false, covers: false });
  });
});

describe("recordFurtherPayment", () => {
  it("adds to what is recorded and keeps the claim open below the bill", async () => {
    await expect(pay(2000)).resolves.toEqual({ status: "partially_paid", paidAmountCents: 7000 });
    expect(write().values).toEqual(["partially_paid", 7000, SB, ORG]);
    expect(trailLine()).toBe("Recorded another payment — $20.00, making $70.00 of the $150.00 billed");
  });

  it("reads a total stored as a bigint", async () => {
    h.bill = { ...h.bill, paid_amount_cents: BigInt(5000), billed_amount_cents: BigInt(15000) };
    await expect(pay(2000)).resolves.toMatchObject({ paidAmountCents: 7000 });
  });

  it("closes the claim as paid when the total reaches the bill", async () => {
    await expect(pay(10000)).resolves.toEqual({ status: "paid", paidAmountCents: 15000 });
    expect(trailLine()).toBe("Recorded another payment — $100.00, making $150.00: paid in full");
  });

  it("closes below the bill when it is the payer's last payment", async () => {
    await expect(pay(5000, { last: true })).resolves.toEqual({ status: "paid", paidAmountCents: 10000 });
    expect(trailLine()).toBe("Recorded the last payment — $50.00, closed as paid at $100.00 of the $150.00 billed");
  });

  it("CONTROL: without 'last' the same amount leaves it open", async () => {
    await expect(pay(5000)).resolves.toEqual({ status: "partially_paid", paidAmountCents: 10000 });
  });

  it("refuses a total above the bill until it is confirmed as an overpayment, and writes nothing", async () => {
    await expect(pay(500000)).rejects.toThrow(/makes \$5050\.00 paid on a claim billed \$150\.00/);
    expect(h.calls.some((c) => c.sql.includes("UPDATE superbill SET"))).toBe(false);
    expect(h.calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("records a confirmed overpayment as paid, and says so on the history and in the audit row", async () => {
    await expect(pay(12000, { overpaymentAcknowledged: true })).resolves.toEqual({ status: "paid", paidAmountCents: 17000 });
    expect(trailLine()).toContain("more than the $150.00 billed, confirmed as an overpayment");
    expect(h.audit.mock.calls[0]![1].payload.overpayment).toEqual({ billedAmountCents: 15000 });
  });

  it("marks the total as typed, over an 835's figure: it is no longer the payer's word alone", async () => {
    await pay(2000);
    expect(write().sql).toContain("paid_source = 'recorded'");
  });

  it("logs this payment and the total, by amount only", async () => {
    await pay(5000, { last: true });
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      action: "superbill_status_change",
      targetId: SB,
      payload: { from: "partially_paid", to: "paid", paidAmountCents: 10000, paymentCents: 5000, lastPayment: true, visitId: "v" },
    });
  });

  it("goes only on a partially paid claim", async () => {
    for (const status of ["draft", "ready_to_submit", "submitted", "paid", "denied", "voided"]) {
      h.bill = { ...h.bill, status };
      await expect(pay(2000)).rejects.toThrow(/goes on a partially paid claim/);
    }
    expect(h.calls.some((c) => c.sql.includes("UPDATE superbill SET"))).toBe(false);
  });

  it("refuses a claim that is not there, or is on its way to the clearinghouse", async () => {
    h.bill = null;
    await expect(pay(2000)).rejects.toThrow(/not found/);
    h.bill = { status: "partially_paid", paid_amount_cents: 5000, billed_amount_cents: 15000, visit_id: "v" };
    h.sending = true;
    await expect(pay(2000)).rejects.toThrow(/being sent to the clearinghouse/);
  });

  it("locks the claim, so two payments recorded at once both count", async () => {
    await pay(2000);
    expect(h.calls[0]!.sql).toContain("FOR UPDATE");
  });
});

describe("POST /api/superbills/[id]/payments", () => {
  it("asks for the same permission as recording any payment", async () => {
    const r = await POST(new NextRequest("http://localhost/x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: SB }) });
    expect(r.status).toBe(403);
    expect(h.calls.find((c) => c.sql === "requireAuth")!.values).toEqual(["billing.superbills.edit"]);
  });
});
