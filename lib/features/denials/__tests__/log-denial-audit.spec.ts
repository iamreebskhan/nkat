/**
 * A denial logged from the EOB reaches the audit log (review of audit R24).
 *
 * logDenial moves a submitted or partially-paid claim to 'denied' with its own
 * UPDATE, and wrote only the claim history. A visit's audit trail then went
 * straight from "submitted" to a refile decision. It now writes the status
 * change, ids and statuses only.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text. The bill lookup is
 * the exception: sql-fake RUNS it over two orgs' bills, the other org's first,
 * with no RLS, so its own predicates decide which bill it finds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/superbills/superbill.service", () => ({ markStatus: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { run as runSql, type FakeDb } from "@/lib/features/team/__tests__/sql-fake";

import { logDenial } from "../denial.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "b2e303af-e2cb-4292-8d00-c35c07423a0d";
const DENIAL = "d0000000-0000-4000-8000-000000000009";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
/** A claim of another org: the id a typo, or a pasted link, would bring. */
const FOREIGN_SB = "b2e303af-e2cb-4292-8d00-c35c07423aff";

const bills = (): FakeDb => ({
  superbill: {
    columns: ["id", "org_id", "payer_id", "status"],
    rows: [
      { id: FOREIGN_SB, org_id: OTHER_ORG, payer_id: "a0000000-0000-4000-8000-000000000301", status: "submitted" },
      { id: SB, org_id: ORG, payer_id: null, status: "submitted" },
    ],
  },
});

/** What the status move hands back: empty when the claim was not submitted/partially paid. */
let moved: { from_status: string; visit_id: string | null }[];
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT payer_id FROM superbill")) return Promise.resolve(runSql(bills(), strings, values));
    if (sql.includes("INSERT INTO superbill_denial")) return Promise.resolve([{ id: DENIAL }]);
    if (sql.includes("WITH prev AS")) return Promise.resolve(moved);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  moved = [{ from_status: "submitted", visit_id: VISIT }];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const input = {
  superbillId: SB,
  cptCode: "99344",
  carcCode: "50",
  denialReason: "Not medically necessary per Stephen's plan",
  deniedAmountCents: 11401,
  deniedAt: "2026-09-14T00:00:00Z",
};

const statusRow = () =>
  calls.find((c) => c.sql.includes("INSERT INTO audit_log") && c.values.includes("superbill_status_change"));

describe("logDenial — audit", () => {
  it("records the claim moving to denied, with its visit and the new denial id", async () => {
    await logDenial({ orgId: ORG, payload: input as never, actorUserId: USER });
    const row = statusRow()!;
    expect(row).toBeDefined();
    expect(row.values).toContain(USER);
    expect(row.values).toContain(SB);
    const payload = JSON.parse(String(row.values.find((v) => typeof v === "string" && v.startsWith("{"))));
    expect(payload).toEqual({ from: "submitted", to: "denied", visitId: VISIT, denialId: DENIAL });
  });

  it("keeps the CARC and the free-text reason out of the audit row", async () => {
    await logDenial({ orgId: ORG, payload: input as never, actorUserId: USER });
    const text = JSON.stringify(statusRow()!.values);
    expect(text).not.toContain("Stephen");
    expect(text).not.toContain("medically");
  });

  it("writes no status change when the claim did not move (a draft or paid claim)", async () => {
    moved = [];
    await logDenial({ orgId: ORG, payload: input as never, actorUserId: USER });
    expect(statusRow()).toBeUndefined();
    // The denial itself is still recorded.
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_denial"))).toBe(true);
  });

  it("refuses another org's claim: not found, and no denial or history row is written", async () => {
    // superbill_denial's foreign key is checked with row security off, so even
    // on the app role a bill id from another org used to be accepted: a denial
    // and a claim-history row in this org, against a claim it cannot open.
    await expect(
      logDenial({ orgId: ORG, payload: { ...input, superbillId: FOREIGN_SB } as never, actorUserId: USER }),
    ).rejects.toMatchObject({ name: "NotFoundError", message: "Superbill not found." });
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_denial"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("WITH prev AS"))).toBe(false);
  });

  it("CONTROL: this org's claim is found and its denial recorded", async () => {
    await expect(logDenial({ orgId: ORG, payload: input as never, actorUserId: USER })).resolves.toEqual({
      id: DENIAL,
    });
  });

  it("moves only a submitted or partially-paid claim, under a row lock", async () => {
    await logDenial({ orgId: ORG, payload: input as never, actorUserId: USER });
    const move = calls.find((c) => c.sql.includes("WITH prev AS"))!;
    expect(move.sql).toContain("status IN ('submitted', 'partially_paid')");
    expect(move.sql).toContain("FOR UPDATE");
  });
});
