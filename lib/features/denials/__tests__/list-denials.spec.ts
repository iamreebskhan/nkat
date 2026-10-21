/**
 * The denials screen's figures describe every denial that matches the filter,
 * not the first page of them (audit R34).
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/superbills/superbill.service", () => ({ markStatus: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { listDenials, summarizeDenials } from "../denial.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PAYER_A = "a0000000-0000-4000-8000-000000000305";
const PAYER_B = "a0000000-0000-4000-8000-000000000301";

let summaryRows: { carc_code: string; payer_id: string | null; denied_amount_cents: bigint; decision: string }[];
let calls: { sql: string; values: unknown[] }[] = [];
/** The global payer catalog, withdrawn payers included. */
let payerTable: { id: string; name: string; active: boolean }[];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT carc_code, payer_id, denied_amount_cents, decision")) {
      return Promise.resolve(summaryRows);
    }
    if (sql.includes("FROM payer WHERE id = ANY")) {
      const ids = values[0] as string[];
      return Promise.resolve(payerTable.filter((p) => ids.includes(p.id)).map(({ id, name }) => ({ id, name })));
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  payerTable = [];
  // 120 denials: 90 pending on payer A at $100, 30 refile on payer B at $500.
  summaryRows = [
    ...Array.from({ length: 90 }, () => ({
      carc_code: "16", payer_id: PAYER_A, denied_amount_cents: BigInt(10_000), decision: "pending",
    })),
    ...Array.from({ length: 30 }, () => ({
      carc_code: "50", payer_id: PAYER_B, denied_amount_cents: BigInt(50_000), decision: "refile",
    })),
  ];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("summarizeDenials", () => {
  it("counts every matching denial — 120, not the first 50", async () => {
    const m = await summarizeDenials({ orgId: ORG });
    expect(m.total).toBe(120);
    expect(m.pendingDecisions).toBe(90);
    expect(m.totalDeniedCents).toBe(90 * 10_000 + 30 * 50_000);
  });

  it("ranks payers by dollars denied, not by count", async () => {
    const m = await summarizeDenials({ orgId: ORG });
    expect(m.byPayerId[0]).toEqual({ payerId: PAYER_B, count: 30, deniedCents: 1_500_000 });
    expect(m.byPayerId[1]).toEqual({ payerId: PAYER_A, count: 90, deniedCents: 900_000 });
  });

  it("reads with no LIMIT and applies the same filters as the list", async () => {
    await summarizeDenials({ orgId: ORG, decision: "pending", payerId: PAYER_A });
    const q = calls[0]!;
    expect(q.sql).not.toContain("LIMIT");
    expect(q.sql).toContain("decision = ");
    expect(q.sql).toContain("payer_id = ");
    expect(q.values).toContain("pending");
    expect(q.values).toContain(PAYER_A);
  });
});

describe("listDenials — paging", () => {
  it("pages with OFFSET", async () => {
    await listDenials({ orgId: ORG, limit: 50, offset: 100 });
    const q = calls[0]!;
    expect(q.sql).toContain("OFFSET");
    expect(q.values).toContain(100);
  });

  it("clamps a negative offset to 0", async () => {
    await listDenials({ orgId: ORG, offset: -1 });
    expect(calls[0]!.values).toContain(0);
    expect(calls[0]!.values).not.toContain(-1);
  });
});

/**
 * The screen named payers from /api/billing/payers, which lists active payers
 * only since R17, so a withdrawn payer's row read as a UUID prefix and the
 * filter caption as "for this payer". The names now come with the figures.
 */
describe("summarizeDenials — payer names (R17)", () => {
  it("names a withdrawn payer's row, and (CONTROL) an active payer's", async () => {
    payerTable = [
      { id: PAYER_A, name: "Active Health Plan", active: true },
      { id: PAYER_B, name: "Withdrawn Health Plan", active: false },
    ];
    const m = await summarizeDenials({ orgId: ORG });
    expect(m.payerNames).toEqual({ [PAYER_A]: "Active Health Plan", [PAYER_B]: "Withdrawn Health Plan" });
    const q = calls.find((c) => c.sql.includes("FROM payer WHERE id = ANY"))!;
    // Not the active-only list the screen used to read.
    expect(q.sql).not.toContain("active");
    expect([...(q.values[0] as string[])].sort()).toEqual([PAYER_A, PAYER_B].sort());
  });

  it("names the payer being filtered on even when no denial matches", async () => {
    summaryRows = [];
    payerTable = [{ id: PAYER_B, name: "Withdrawn Health Plan", active: false }];
    const m = await summarizeDenials({ orgId: ORG, decision: "pending", payerId: PAYER_B });
    expect(m.total).toBe(0);
    expect(m.payerNames).toEqual({ [PAYER_B]: "Withdrawn Health Plan" });
  });

  it("does not look payers up when there is none to name", async () => {
    summaryRows = [{ carc_code: "16", payer_id: null, denied_amount_cents: BigInt(100), decision: "pending" }];
    const m = await summarizeDenials({ orgId: ORG });
    expect(calls.some((c) => c.sql.includes("FROM payer WHERE"))).toBe(false);
    expect(m.payerNames).toEqual({});
    expect(m.byPayerId).toEqual([{ payerId: null, count: 1, deniedCents: 100 }]);
  });
});
