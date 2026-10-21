/**
 * A visit's bill is written once (persistDraft).
 *
 * A second save for a visit that already had a bill wrote the visit's codes,
 * units, diagnoses, modifiers and price over it, whatever its status, with no
 * line on the bill's history and another superbill_create in the audit log. On
 * localhost a "Save superbill" from a page opened before the bill existed wiped
 * a reviewed bill's modifier 33 and left it "ready to submit"; submitting the
 * visit for billing did the same to a biller's edit. Signing freezes the
 * visit's codes, so a second save never had anything newer to bring.
 *
 * lib/db is mocked with a fake tx holding the visit's one bill row. Its INSERT
 * answers as Postgres does for each ON CONFLICT form, so the statement the
 * service sends decides what happens to the bill.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));
vi.mock("@/lib/features/billing/predict-superbill.service", () => ({ predictSuperbill: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { predictSuperbill } from "@/lib/features/billing/predict-superbill.service";

import type { DraftSuperbill } from "../superbill-pure";
import { persistDraft } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "d855b6b1-e2c2-49c7-9ecc-17bbdc29a12f";
const PATIENT = "100d40c3-2ce2-4d86-8b55-58e9f42f55fa";
const HELEN = "d0000000-0000-4000-8000-000000000101";
const NEW_BILL = "5b000000-0000-4000-8000-000000000001";
const SAVED_BILL = "4aa35448-1786-46fb-8fe9-434bb29af746";

/** The visit's draft: its signed codes, no modifier. */
const DRAFT = {
  visitId: VISIT, patientId: PATIENT, payerId: null, memberIdSnapshot: "M-1",
  dateOfService: "2026-10-20", cptCodes: ["99497"], cptUnits: {}, icd10Codes: ["C34.90"],
  modifiers: [], providerNpi: "1234567893", providerName: "Helen Okafor", billingNpi: "1234567893",
  placeOfServiceCode: "12", billedAmountCents: 7660, ratedCodes: [], unratedCodes: [], warnings: [],
  pricing: { lines: [] },
} as unknown as DraftSuperbill;

interface Bill {
  id: string;
  status: string;
  cptCodes: string[];
  modifiers: string[];
  icd10Codes: string[];
  billed: number;
}

/** The visit's bill as the database holds it; null = none. */
let bill: Bill | null;
/** A bill someone else saves between the service's read and its insert. */
let savedMeanwhile: Bill | null;
let calls: { sql: string; values: unknown[] }[];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM patient")) return Promise.resolve([{ state: "OH" }]);
    if (sql.includes("SELECT id FROM superbill WHERE visit_id")) {
      return Promise.resolve(bill ? [{ id: bill.id }] : []);
    }
    if (sql.includes("INSERT INTO superbill (")) {
      if (savedMeanwhile) {
        bill = savedMeanwhile;
        savedMeanwhile = null;
      }
      if (!bill) {
        bill = { id: NEW_BILL, status: "draft", cptCodes: DRAFT.cptCodes, modifiers: DRAFT.modifiers, icd10Codes: DRAFT.icd10Codes, billed: DRAFT.billedAmountCents };
        return Promise.resolve([{ id: NEW_BILL }]);
      }
      if (/ON CONFLICT \(visit_id\) DO NOTHING/.test(sql)) return Promise.resolve([]);
      if (sql.includes("DO UPDATE SET")) {
        // What the statement before this fix did to the bill it hit.
        bill = { ...bill, cptCodes: DRAFT.cptCodes, modifiers: DRAFT.modifiers, icd10Codes: DRAFT.icd10Codes, billed: DRAFT.billedAmountCents };
        return Promise.resolve([{ id: bill.id }]);
      }
      return Promise.reject(new Error('duplicate key value violates unique constraint "superbill_visit_id_key"'));
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve(0) };
}

/** A biller's bill: modifier 33 added, reviewed or further along. */
const billersBill = (status: string): Bill => ({
  id: SAVED_BILL, status, cptCodes: ["99497"], modifiers: ["33"], icd10Codes: ["C34.90"], billed: 7660,
});

beforeEach(() => {
  vi.clearAllMocks();
  bill = null;
  savedMeanwhile = null;
  calls = [];
  vi.mocked(predictSuperbill).mockResolvedValue({ worstBand: "low" } as never);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const save = () => persistDraft({ orgId: ORG, draft: DRAFT, actorUserId: HELEN });
const writes = () =>
  calls.filter((c) => /INSERT INTO superbill \(|INSERT INTO superbill_activity|UPDATE superbill/.test(c.sql));

describe("persistDraft — a visit's first save", () => {
  it("writes the bill, starts its history and records the create", async () => {
    expect(await save()).toEqual({ id: NEW_BILL, created: true });
    expect(bill).toMatchObject({ id: NEW_BILL, status: "draft" });
    expect(calls.filter((c) => c.sql.includes("INSERT INTO superbill_activity"))).toHaveLength(1);
    expect(vi.mocked(writeAudit).mock.calls.map(([, a]) => a.action)).toEqual(["superbill_create"]);
    // Scored once, for the bill being written.
    expect(predictSuperbill).toHaveBeenCalledTimes(1);
  });

  it("can no longer update a bill it collides with", async () => {
    await save();
    const insert = calls.find((c) => c.sql.includes("INSERT INTO superbill ("))!;
    expect(insert.sql).toContain("ON CONFLICT (visit_id) DO NOTHING");
    expect(insert.sql).not.toContain("DO UPDATE");
  });
});

describe("persistDraft — a visit that already has a bill", () => {
  it.each(["draft", "ready_to_submit", "submitted", "partially_paid", "paid", "denied", "voided"])(
    "returns the %s bill unchanged, and writes nothing",
    async (status) => {
      bill = billersBill(status);
      expect(await save()).toEqual({ id: SAVED_BILL, created: false });
      // The biller's modifier, the status and the price stand.
      expect(bill).toEqual(billersBill(status));
      expect(writes()).toEqual([]);
      expect(writeAudit).not.toHaveBeenCalled();
    },
  );

  it("does not score a bill it is not writing", async () => {
    bill = billersBill("ready_to_submit");
    await save();
    expect(predictSuperbill).not.toHaveBeenCalled();
  });

  it("reads the bill by visit and by this org", async () => {
    bill = billersBill("submitted");
    await save();
    const read = calls.find((c) => c.sql.includes("SELECT id FROM superbill WHERE visit_id"))!;
    expect(read.values).toEqual([VISIT, ORG]);
  });

  it("keeps a bill saved by someone else between its read and its insert", async () => {
    // Two saves at once: the other one's insert committed first.
    savedMeanwhile = billersBill("draft");
    expect(await save()).toEqual({ id: SAVED_BILL, created: false });
    expect(bill).toEqual(billersBill("draft"));
    // Their bill already has its "created" line and audit row.
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
