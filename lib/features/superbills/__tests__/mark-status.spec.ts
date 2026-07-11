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
import { markStatus } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";

let currentStatus: string;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT status FROM superbill")) {
      return Promise.resolve(currentStatus ? [{ status: currentStatus }] : []);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  currentStatus = "submitted";
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

  it("draft → submitted stamps submitted_at", async () => {
    currentStatus = "draft";
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
});
