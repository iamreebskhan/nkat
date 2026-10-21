/**
 * What a denial outcome may record as recovered.
 *
 * The amount was bounded by nothing. The route's schema takes any non-negative
 * integer, and nothing compared the figure to what this denial denied — so the
 * cents/dollars slip the claims queue now refuses on a payment (9850 typed for
 * $98.50) wrote $98.50 recovered against a $9.85 denial, and the denial screen
 * printed it back as fact. The claim is the bound on a payment; the denial is
 * the bound here, with the same confirmed-overpayment way through it.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/superbills/superbill.service", () => ({ markStatus: vi.fn() }));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

import { recordOutcome } from "../denial.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const DENIAL = "d0000000-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VISIT = "e0000000-0000-4000-8000-00000000000a";

/** What this denial denied, in cents. BIGINT reads back as a BigInt. */
let deniedAmountCents: number;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT denied_amount_cents")) {
      return Promise.resolve([{ denied_amount_cents: BigInt(deniedAmountCents) }]);
    }
    if (sql.includes("UPDATE superbill_denial") && sql.includes("RETURNING")) {
      return Promise.resolve([{ visit_id: VISIT }]);
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  deniedAmountCents = 9850;
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const find = (frag: string) => calls.filter((c) => c.sql.includes(frag));
/** Statements that write: the bound's own read ends in FOR UPDATE. */
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.sql));
const payload = () =>
  JSON.parse(
    String(
      find("INSERT INTO audit_log")[0]!.values.find(
        (v) => typeof v === "string" && v.startsWith("{"),
      ),
    ),
  );

describe("recordOutcome — the denial is the bound on the amount", () => {
  it("refuses more than the denial denied, naming both figures, and writes nothing", async () => {
    deniedAmountCents = 985;
    const call = recordOutcome({
      orgId: ORG, id: DENIAL, outcome: "paid", amountCents: 9850, byUserId: USER,
    });
    await expect(call).rejects.toBeInstanceOf(ValidationError);
    await expect(call).rejects.toThrow(
      "That records $98.50 recovered on a denial of $9.85. Amounts are recorded in dollars and cents, so $50.00 is 50.00, not 5000. If the payer really did pay more than it denied, confirm it as an overpayment.",
    );
    // Refused before the write, not after it: nothing changed, nothing audited.
    expect(writes()).toHaveLength(0);
  });

  it("reads the bound from the denial in the same transaction as the write", async () => {
    await recordOutcome({ orgId: ORG, id: DENIAL, outcome: "paid", amountCents: 9850 });
    const read = find("SELECT denied_amount_cents")[0]!;
    expect(read.sql).toContain("FOR UPDATE");
    expect(read.values).toEqual([DENIAL, ORG]);
    expect(calls.findIndex((c) => c.sql.includes("SELECT denied_amount_cents"))).toBeLessThan(
      calls.findIndex((c) => c.sql.includes("UPDATE superbill_denial")),
    );
    expect(withOrgContext).toHaveBeenCalledTimes(1);
  });

  it("records the same figure once the caller confirms the overpayment, saying so in the audit row", async () => {
    await recordOutcome({
      orgId: ORG, id: DENIAL, outcome: "paid", amountCents: 12000, byUserId: USER,
      overpaymentAcknowledged: true,
    });
    expect(find("UPDATE superbill_denial")[0]!.values).toContain(12000);
    expect(payload()).toEqual({
      outcome: "paid",
      visitId: VISIT,
      amountCents: 12000,
      overpayment: { deniedAmountCents: 9850 },
    });
  });

  it("refuses an acknowledged overpayment recorded as a PARTIAL recovery, and writes nothing", async () => {
    await expect(
      recordOutcome({
        orgId: ORG, id: DENIAL, outcome: "partially_paid", amountCents: 12000,
        byUserId: USER, overpaymentAcknowledged: true,
      }),
    ).rejects.toThrow(
      "$120.00 is more than the $98.50 this denial denied, so it is not a partial recovery. Record it as paid, confirming the overpayment there.",
    );
    expect(writes()).toHaveLength(0);
  });

  it("leaves a denial recorded with no amount unbounded: $0.00 denied would refuse every outcome", async () => {
    // The queue's one-click Record denial writes denied_amount_cents 0, and an
    // amount is still the honest thing to record against it.
    deniedAmountCents = 0;
    await recordOutcome({ orgId: ORG, id: DENIAL, outcome: "paid", amountCents: 5000, byUserId: USER });
    expect(find("UPDATE superbill_denial")[0]!.values).toContain(5000);
    expect(payload()).not.toHaveProperty("overpayment");
  });

  it("reads nothing when no amount is named: a write-off has none to bound", async () => {
    await recordOutcome({ orgId: ORG, id: DENIAL, outcome: "written_off", byUserId: USER });
    expect(find("SELECT denied_amount_cents")).toHaveLength(0);
    expect(payload()).toEqual({ outcome: "written_off", visitId: VISIT });
  });

  it("CONTROL — an amount the denial covers is recorded as before, with nothing said about overpayment", async () => {
    await recordOutcome({ orgId: ORG, id: DENIAL, outcome: "partially_paid", amountCents: 5000, byUserId: USER });
    expect(find("UPDATE superbill_denial")[0]!.values).toContain(5000);
    expect(payload()).toEqual({ outcome: "partially_paid", visitId: VISIT, amountCents: 5000 });
  });
});
