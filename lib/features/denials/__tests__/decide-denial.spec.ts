/**
 * Denial decisions and outcomes reach the audit log (audit R24).
 *
 * decideDenial and recordOutcome changed superbill_denial and wrote nothing
 * else, so a visit's audit trail stopped at the claim's creation. Each now
 * writes one row in the same transaction: the decision or outcome and the
 * visit, never the free-text notes, which can carry anything.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 *
 * A denial that is not found — another org's, or none — is a 404, not a 200
 * that changed nothing: the routes answered OK for a decision or an outcome
 * nothing recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/superbills/superbill.service", () => ({ markStatus: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { decideDenial, recordOutcome } from "../denial.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const DENIAL = "d0000000-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VISIT = "e0000000-0000-4000-8000-00000000000a";

/** What the UPDATE ... RETURNING hands back. Empty = no denial matched. */
let updated: { visit_id: string | null }[];
const NOT_FOUND = { name: "NotFoundError", message: "Denial not found." };
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("UPDATE superbill_denial") && sql.includes("RETURNING")) {
      return Promise.resolve(updated);
    }
    // recordOutcome's bound read: the same denial the UPDATE would match.
    if (sql.includes("SELECT denied_amount_cents FROM superbill_denial")) {
      return Promise.resolve(updated.length > 0 ? [{ denied_amount_cents: 10_000 }] : []);
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  updated = [{ visit_id: VISIT }];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const audit = () => calls.find((c) => c.sql.includes("INSERT INTO audit_log"));
const payload = () => JSON.parse(String(audit()!.values.find((v) => String(v).startsWith("{"))));

describe("decideDenial", () => {
  it("writes denial_decision with the decision and the visit, and no notes", async () => {
    await decideDenial({
      orgId: ORG, id: DENIAL, decision: "refile", byUserId: USER,
      notes: "Called Stephen's plan about the CC",
    });
    expect(audit()!.values).toContain("denial_decision");
    expect(audit()!.values).toContain("denial");
    expect(audit()!.values).toContain(USER);
    expect(audit()!.values).toContain(DENIAL);
    expect(payload()).toEqual({ decision: "refile", visitId: VISIT });
    expect(JSON.stringify(audit()!.values)).not.toContain("Stephen");
  });

  it("writes it after a write-off's outcome cascade, in the same transaction", async () => {
    await decideDenial({ orgId: ORG, id: DENIAL, decision: "write_off", byUserId: USER });
    const cascade = calls.findIndex((c) => c.sql.includes("outcome = 'written_off'"));
    const row = calls.findIndex((c) => c.sql.includes("INSERT INTO audit_log"));
    expect(cascade).toBeGreaterThanOrEqual(0);
    expect(row).toBeGreaterThan(cascade);
    expect(withOrgContext).toHaveBeenCalledTimes(1);
  });

  it("is not found when no denial matched, and writes nothing more", async () => {
    updated = [];
    await expect(
      decideDenial({ orgId: ORG, id: DENIAL, decision: "write_off", byUserId: USER }),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(audit()).toBeUndefined();
    // Nor the write-off's outcome cascade.
    expect(calls.some((c) => c.sql.includes("outcome = 'written_off'"))).toBe(false);
  });
});

describe("recordOutcome", () => {
  it("writes denial_outcome with the outcome, the amount and the visit, never notes", async () => {
    await recordOutcome({
      orgId: ORG, id: DENIAL, outcome: "partially_paid", amountCents: 5000,
      notes: "Stephen's EOB", byUserId: USER,
    });
    expect(audit()!.values).toContain("denial_outcome");
    expect(audit()!.values).toContain(USER);
    expect(payload()).toEqual({ outcome: "partially_paid", visitId: VISIT, amountCents: 5000 });
    expect(JSON.stringify(audit()!.values)).not.toContain("Stephen");
  });

  it("is not found when no denial matched, and writes nothing", async () => {
    updated = [];
    await expect(recordOutcome({ orgId: ORG, id: DENIAL, outcome: "paid" })).rejects.toMatchObject(NOT_FOUND);
    expect(audit()).toBeUndefined();
  });

  it("is not found before anything is written when the amount's bound has no denial to read", async () => {
    updated = [];
    await expect(
      recordOutcome({ orgId: ORG, id: DENIAL, outcome: "paid", amountCents: 5000 }),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(calls.some((c) => c.sql.includes("UPDATE superbill_denial"))).toBe(false);
  });
});
