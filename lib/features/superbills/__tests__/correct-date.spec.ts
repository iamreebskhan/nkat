/**
 * Correcting a bill's date of service to the day its visit started where the
 * practice is (0107).
 *
 * A bill drafted before 0107 was dated by the visit start's UTC day — for an
 * evening visit in the US, the next day — and a draft keeps the date it was
 * created with. Shirley Tanaka's draft on localhost carried 23 Sep for an
 * 8:30 pm Ohio visit on the 22nd. The correction re-dates it, reprices it at
 * the payer's rates for the corrected day, and says so on the bill's history;
 * a claim already sent keeps the date the payer holds.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text. The payer's rate
 * changes on 23 Sep in this fixture, so a correction that kept the old price
 * would show.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));
vi.mock("@/lib/features/billing/predict-superbill.service", () => ({ predictSuperbill: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { predictSuperbill } from "@/lib/features/billing/predict-superbill.service";

import { correctDateOfService } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const BILL = "76b7cf7f-966a-4cc0-8837-1fb07eac436f";
const VISIT = "d0000000-0000-4000-8000-000000000347";
const PAYER = "a0000000-0000-4000-8000-000000000304";
const HELEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** The bill as stored; null = not this org's, or none. */
let bill: { status: string; dos: string; day: string | null; billed: number } | null;
let calls: { sql: string; values: unknown[] }[];
const ratesAskedFor: string[] = [];

/** 99349 at $70.13 until 22 Sep, $71.50 from 23 Sep. */
const rateOn = (dos: string) => (dos >= "2026-09-23" ? 71.5 : 70.13);

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("AS day") && sql.includes("FOR UPDATE OF s")) {
      return Promise.resolve(bill ? [{ status: bill.status, dos: bill.dos, day: bill.day, billed: bill.billed }] : []);
    }
    if (sql.includes("UPDATE superbill SET date_of_service")) {
      bill!.dos = values[0] as string;
      return Promise.resolve(1);
    }
    if (sql.includes("s.pricing->>'tier'")) {
      return Promise.resolve([{
        payer_id: PAYER, dos: bill!.dos, coverage_state: "OH", tier: "MD", credential: "NP",
        cpt: ["99349"], units: {}, billed: bill!.billed, facility: null,
      }]);
    }
    if (sql.includes("SELECT payer_type FROM payer")) return Promise.resolve([{ payer_type: "medicaid_mco" }]);
    if (sql.includes("FROM payer_rule pr")) {
      // `effective_date <= ¶::date`: the day the rates are read for.
      const at = sql.slice(0, sql.indexOf("pr.effective_date <= ¶")).split("¶").length - 1;
      const dos = values[at] as string;
      ratesAskedFor.push(dos);
      return Promise.resolve([{
        code: "99349", id: "rule-99349", value: { rate: rateOn(dos) }, effective_date: dos >= "2026-09-23" ? "2026-09-23" : "2024-01-01",
      }]);
    }
    if (sql.includes("SET billed_amount_cents")) {
      bill!.billed = values[0] as number;
      return Promise.resolve(1);
    }
    if (sql.includes("UPDATE superbill SET status = 'draft'")) {
      bill!.status = "draft";
      return Promise.resolve([{ visit_id: VISIT }]);
    }
    if (sql.includes("s.date_of_service AS dos")) {
      // The risk recapture's read, after the correction committed.
      return Promise.resolve([{ payer_id: PAYER, patient_id: "p", dos: new Date(`${bill!.dos}T00:00:00Z`), state: "OH", cpt: ["99349"], mods: [] }]);
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  ratesAskedFor.length = 0;
  bill = { status: "draft", dos: "2026-09-23", day: "2026-09-22", billed: 7150 };
  vi.mocked(predictSuperbill).mockResolvedValue({} as never);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const correct = () => correctDateOfService({ orgId: ORG, id: BILL, userId: HELEN });
const history = () => calls.filter((c) => c.sql.includes("INSERT INTO superbill_activity"));
const writes = () => calls.filter((c) => /UPDATE superbill|INSERT INTO superbill_activity/.test(c.sql));

describe("correctDateOfService", () => {
  it("re-dates a draft to its visit's day and reprices it at that day's rate", async () => {
    const r = await correct();
    expect(r).toEqual({ from: "2026-09-23", to: "2026-09-22", billedAmountCents: 7013, status: "draft" });
    expect(bill).toMatchObject({ dos: "2026-09-22", billed: 7013 });
    // The rates were read for the corrected day, not the old one.
    expect(ratesAskedFor).toEqual(["2026-09-22"]);
  });

  it("says so on the bill's history: both dates and both prices", async () => {
    await correct();
    expect(history()).toHaveLength(1);
    const h = history()[0]!;
    expect(h.values).toContain(
      "Date of service corrected to 2026-09-22, the day the visit started at the practice (was 2026-09-23)",
    );
    const detail = JSON.parse(String(h.values.find((v) => String(v).startsWith("{"))));
    expect(detail).toEqual({
      dateOfService: { before: "2026-09-23", after: "2026-09-22" },
      billedAmountCents: { before: 7150, after: 7013 },
    });
    // A draft stays a draft, with no status change to audit.
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("sends a reviewed bill back to draft for re-review, as any edit does", async () => {
    bill!.status = "ready_to_submit";
    const r = await correct();
    expect(r.status).toBe("draft");
    expect(vi.mocked(writeAudit).mock.calls[0]![1]).toMatchObject({
      action: "superbill_status_change",
      payload: { from: "ready_to_submit", to: "draft", visitId: VISIT },
    });
    expect(String(history()[0]!.values.find((v) => String(v).startsWith("Date of service")))).toMatch(
      /— back to draft for re-review$/,
    );
  });

  it("recaptures the predictor's view for the corrected day", async () => {
    await correct();
    expect(vi.mocked(predictSuperbill).mock.calls[0]![0]).toMatchObject({ dos: "2026-09-22", excludeSuperbillId: BILL });
  });

  it.each(["submitted", "partially_paid", "paid", "denied", "voided"])(
    "never re-dates a %s claim: the payer holds its date",
    async (status) => {
      bill!.status = status;
      await expect(correct()).rejects.toMatchObject({ name: "ValidationError" });
      expect(writes()).toEqual([]);
    },
  );

  it("refuses when the date is already the visit's day, and writes nothing", async () => {
    bill!.dos = "2026-09-22";
    await expect(correct()).rejects.toMatchObject({
      name: "ValidationError",
      message: "The date of service is already 2026-09-22, the day the visit started.",
    });
    expect(writes()).toEqual([]);
  });

  it("is not found for a bill this org does not have", async () => {
    bill = null;
    await expect(correct()).rejects.toMatchObject({ name: "NotFoundError" });
    expect(writes()).toEqual([]);
  });

  it("reads the bill locked and by this org, its day where the practice is", async () => {
    await correct();
    const read = calls.find((c) => c.sql.includes("AS day"))!;
    expect(read.sql).toContain("AT TIME ZONE o.timezone");
    expect(read.sql).toContain("COALESCE(v.start_time, v.scheduled_start)");
    expect(read.values).toEqual([BILL, ORG]);
  });
});
