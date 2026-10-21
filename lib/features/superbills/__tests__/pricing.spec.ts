/**
 * Pricing a bill from the payer's rate on file (audit R33) and carrying the
 * visit's place of service (audit R23), through the service.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/billing/predict-superbill.service", () => ({
  predictSuperbill: vi.fn().mockResolvedValue(null),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

import { buildDraftFromVisit, persistDraft, updateSuperbill } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
const SB = "86bc0d67-4bfa-4c69-85ac-83c1e725354c";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UHC_OH = "a0000000-0000-4000-8000-000000000302";

type RateRow = { code: string; id: string; value: Record<string, unknown>; effective_date: string };

let visitRow: Record<string, unknown>;
let rateRows: RateRow[];
let repriceCtx: Record<string, unknown> | null;
/** The saved bill's codes and units, as the units read in updateSuperbill sees them. */
let billRow: { cpt_codes: string[]; cpt_units: Record<string, number> };
let calls: { sql: string; values: unknown[] }[] = [];

/** The JSON object bound into a statement, if any — the units map is the only one. */
const jsonBind = (values: unknown[]) => values.find((v) => typeof v === "string" && v.startsWith("{")) as string | undefined;

/**
 * A row carries the units column only when the statement selects it, as in
 * Postgres. These reads used to hand the units back whatever the SELECT named,
 * so deleting v.cpt_units or s.cpt_units from the service left every units
 * control here green while the bill priced one unit.
 */
function selecting(sql: string, column: string, key: string, row: Record<string, unknown>) {
  if (sql.includes(column)) return row;
  const rest = { ...row };
  delete rest[key];
  return rest;
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM visit v") && sql.includes("clinician_npi")) {
      // The org's zone likewise (0107): the draft's date of service is read in it.
      const row = selecting(sql, "v.cpt_units", "cpt_units", visitRow);
      return Promise.resolve([selecting(sql, "o.timezone AS org_timezone", "org_timezone", row)]);
    }
    if (sql.includes("SELECT payer_type FROM payer")) return Promise.resolve([{ payer_type: "medicaid_mco" }]);
    if (sql.includes("FROM payer_rule pr")) {
      const asked = values.find(Array.isArray) as string[];
      return Promise.resolve(rateRows.filter((r) => asked.includes(r.code)));
    }
    if (sql.includes("pricing->>'tier'")) {
      return Promise.resolve(repriceCtx ? [selecting(sql, "s.cpt_units AS units", "units", repriceCtx)] : []);
    }
    if (sql.includes("SELECT id, status FROM superbill")) return Promise.resolve([{ id: SB, status: "draft" }]);
    if (sql.includes("SELECT cpt_codes, cpt_units FROM superbill")) return Promise.resolve([billRow]);
    // The codes-and-units write. It lands in the row the reprice then reads, as
    // it does in Postgres, so the price is decided by what was written.
    if (sql.includes("UPDATE superbill") && sql.includes("cpt_units = ")) {
      billRow = { cpt_codes: values.find(Array.isArray) as string[], cpt_units: JSON.parse(jsonBind(values)!) };
      if (repriceCtx) repriceCtx = { ...repriceCtx, cpt: billRow.cpt_codes, units: billRow.cpt_units };
      return Promise.resolve(1);
    }
    if (sql.includes("INSERT INTO superbill (")) return Promise.resolve([{ id: SB }]);
    if (sql.includes("FROM pos")) {
      return Promise.resolve(["12", "13", "31"].includes(values[0] as string) ? [{ ok: 1 }] : []);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const rateQuery = () => calls.find((c) => c.sql.includes("FROM payer_rule pr"));
const repriceUpdate = () =>
  calls.find((c) => c.sql.includes("UPDATE superbill") && c.sql.includes("billed_amount_cents = "));

beforeEach(() => {
  calls = [];
  visitRow = {
    id: VISIT, status: "documented", patient_id: "p1", is_telehealth: false,
    cpt_codes_assigned: ["99349"], icd10_codes: ["C34.10"], modifiers: [],
    scheduled_start: null, start_time: new Date("2026-09-09T15:00:00Z"),
    primary_payer_id: UHC_OH, primary_member_id: "M1", primary_diagnosis_icd10: null,
    clinician_npi: "1234567893", credential: "NP", org_npi: null, full_name: "Jane NP",
    coverage_state: "OH", place_of_service_code: "12", pos_facility: "non_facility",
    org_timezone: "America/New_York",
  };
  rateRows = [
    { code: "99349", id: "rule-99349", value: { rate: 70.13, rateBasis: "state_medicaid_ffs_non_facility_benchmark" }, effective_date: "2024-01-01" },
    { code: "99350", id: "rule-99350", value: { rate: 101.86, rateBasis: "state_medicaid_ffs_non_facility_benchmark" }, effective_date: "2024-01-01" },
    // A per-unit rate, as the OH Medicaid MCO schedules publish 99417.
    { code: "99417", id: "rule-99417", value: { rate: 23.83 }, effective_date: "2024-01-01" },
  ];
  repriceCtx = {
    payer_id: UHC_OH, dos: "2026-09-09", coverage_state: "OH", tier: "NP_PA", credential: null,
    cpt: ["99350"], billed: BigInt(7013), facility: "non_facility",
  };
  billRow = { cpt_codes: ["99349"], cpt_units: {} };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("buildDraftFromVisit — pricing (audit R33)", () => {
  it("prices at the payer's rate on file, not the reference table", async () => {
    const d = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    expect(d.billedAmountCents).toBe(7013);
    expect(d.pricing.lines[0]).toMatchObject({ code: "99349", source: "payer_fee_schedule", payerRuleId: "rule-99349" });
    expect(d.warnings.some((w) => w.includes("reference table"))).toBe(false);
  });

  it("looks the rate up on the date of service, for the coverage state, the payer's product line first", async () => {
    await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    const q = rateQuery()!;
    expect(q.values).toContain("2026-09-09");
    expect(q.values).toContain("OH");
    expect(q.values).toContain(UHC_OH);
    expect(q.values).toContain("medicaid_mco");
    expect(q.sql).toContain("pr.superseded_by IS NULL");
  });

  it("converts dollars to cents without float drift", async () => {
    rateRows = [{ code: "99349", id: "r", value: { rate: 125.72 }, effective_date: "2024-01-01" }];
    const d = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    expect(d.billedAmountCents).toBe(12572);
  });

  it("with no payer, asks for no rates and says the price is the reference table's", async () => {
    visitRow = { ...visitRow, primary_payer_id: null };
    const d = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    expect(rateQuery()).toBeUndefined();
    expect(d.billedAmountCents).toBe(10179);
    expect(d.warnings.some((w) => w.startsWith("No payer on file"))).toBe(true);
  });

  it("carries the recorded place of service, and prices a facility at its facility rate", async () => {
    visitRow = { ...visitRow, place_of_service_code: "31", pos_facility: "facility" };
    rateRows = [{ code: "99349", id: "r", value: { rate: 70.13, facilityRate: 55 }, effective_date: "2024-01-01" }];
    const d = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    expect(d.placeOfServiceCode).toBe("31");
    expect(d.billedAmountCents).toBe(5500);
  });
});

describe("updateSuperbill — reprices when the price's inputs change (audit R33, R23)", () => {
  it("reprices a code change: 99349 → 99350 bills 99350's rate, not 99349's", async () => {
    const r = await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { cptCodes: ["99350"] } });
    expect(r.billedAmountCents).toBe(10186);
    expect(r.pricing?.lines[0]).toMatchObject({ code: "99350", source: "payer_fee_schedule" });
    const upd = repriceUpdate()!;
    expect(upd.values).toContain(10186);
  });

  it("records the price before and after on the bill's history", async () => {
    await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { cptCodes: ["99350"] } });
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    const detail = JSON.parse(act.values.find((v) => typeof v === "string" && v.includes("billedAmountCents")) as string);
    expect(detail.billedAmountCents).toEqual({ before: 7013, after: 10186 });
  });

  it("does not reprice an edit that changes only the diagnoses", async () => {
    const r = await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { icd10Codes: ["C34.10"] } });
    expect(r.billedAmountCents).toBeUndefined();
    expect(calls.some((c) => c.sql.includes("pricing->>'tier'"))).toBe(false);
    // Nor read or write the units: they follow the codes, not the diagnoses.
    expect(calls.some((c) => c.sql.includes("cpt_units"))).toBe(false);
  });

  it("corrects the place of service on the bill and reprices for it", async () => {
    const r = await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { placeOfServiceCode: "31" } });
    expect(calls.some((c) => c.sql.includes("SET place_of_service_code = "))).toBe(true);
    expect(r.billedAmountCents).toBeDefined();
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(act.values).toContain("Edited place of service");
  });

  it("refuses a code that is not a place of service", async () => {
    await expect(
      updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { placeOfServiceCode: "77" } }),
    ).rejects.toThrow(/Unknown place-of-service code "77"/);
  });
});

/**
 * Units per code (0106) through the service: read off the visit into the
 * draft, written with the bill, edited by the biller, and priced as units ×
 * the per-unit rate every time the bill is priced.
 */
describe("units — the draft, the saved bill and the biller's edit", () => {
  it("CONTROL: prices the visit's 99417 × 2 at two rates", async () => {
    visitRow = { ...visitRow, cpt_codes_assigned: ["99350", "99417"], cpt_units: { "99417": 2 } };
    const d = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    // 99350 at 101.86 + 2 × 99417 at 23.83. One unit billed 12569.
    expect(d.billedAmountCents).toBe(10186 + 2 * 2383);
    expect(d.cptUnits).toEqual({ "99417": 2 });
    expect(d.pricing.lines[1]).toMatchObject({ code: "99417", units: 2, rateCents: 2383, chargeCents: 4766 });
  });

  it("reads a visit saved before 0106 as one unit per code", async () => {
    visitRow = { ...visitRow, cpt_codes_assigned: ["99350", "99417"] };
    const d = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    expect(d.billedAmountCents).toBe(10186 + 2383);
    expect(d.cptUnits).toEqual({});
  });

  it("writes the units with the bill on its first save", async () => {
    visitRow = { ...visitRow, cpt_codes_assigned: ["99350", "99417"], cpt_units: { "99417": 2 } };
    const draft = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    calls = [];
    expect(await persistDraft({ orgId: ORG, draft, actorUserId: USER })).toEqual({ id: SB, created: true });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO superbill ("))!;
    expect(insert.values).toContain('{"99417":2}');
    const created = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(JSON.parse(jsonBind(created.values)!).cptUnits).toEqual({ "99417": 2 });
  });

  it("CONTROL: a units edit is written, repriced and recorded", async () => {
    billRow = { cpt_codes: ["99350", "99417"], cpt_units: {} };
    const r = await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { cptUnits: { "99417": 3 } } });
    expect(r.updated).toBe(true);
    expect(r.cptUnits).toEqual({ "99417": 3 });
    // 10186 + 3 × 2383, priced from the row the edit wrote.
    expect(r.billedAmountCents).toBe(17335);
    expect(billRow).toEqual({ cpt_codes: ["99350", "99417"], cpt_units: { "99417": 3 } });
    const act = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(act.values).toContain("Edited units");
    expect(JSON.parse(act.values.find((v) => typeof v === "string" && v.includes("billedAmountCents")) as string)).toMatchObject({
      cptUnits: { "99417": 3 },
      billedAmountCents: { before: 7013, after: 17335 },
    });
  });

  it("CONTROL: refuses units on a code billed once per visit, and writes nothing", async () => {
    billRow = { cpt_codes: ["99350", "99417"], cpt_units: {} };
    const refused = updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { cptUnits: { "99350": 2 } } });
    // A ValidationError, which the route answers 422 (lib/api.ts); any other
    // error is a 500 with the message hidden.
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toThrow(/units apply only to/);
    expect(calls.some((c) => c.sql.includes("UPDATE superbill"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO superbill_activity"))).toBe(false);
  });

  it("CONTROL: refuses a count outside 1–99 rather than quietly billing one unit", async () => {
    // The route's schema refuses these first; without it the service used to
    // drop the count, write {} and reprice at one unit.
    billRow = { cpt_codes: ["99350", "99417"], cpt_units: { "99417": 3 } };
    for (const bad of [150, 0, 2.5]) {
      const refused = updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { cptUnits: { "99417": bad } } });
      await expect(refused, String(bad)).rejects.toBeInstanceOf(ValidationError);
      await expect(refused, String(bad)).rejects.toThrow(/whole number from 1 to 99/);
    }
    expect(calls.some((c) => c.sql.includes("UPDATE superbill"))).toBe(false);
    expect(billRow.cpt_units).toEqual({ "99417": 3 });
  });

  it("CONTROL: bills a code sent twice once, at its units", async () => {
    // A repeat reaches the bill only through the API. It was priced twice,
    // so 99417 × 3 billed six units beside a bill printing "99417 ×3".
    const r = await updateSuperbill({
      orgId: ORG, id: SB, userId: USER,
      patch: { cptCodes: ["99350", "99417", "99417"], cptUnits: { "99417": 3 } },
    });
    expect(r.billedAmountCents).toBe(10186 + 3 * 2383);
    expect(r.pricing?.lines.map((l) => [l.code, l.units])).toEqual([
      ["99350", 1],
      ["99417", 3],
    ]);
  });

  it("CONTROL: removing a code drops its units, and says so — the page must not show a stale × 2", async () => {
    billRow = { cpt_codes: ["99350", "99417"], cpt_units: { "99417": 2 } };
    const r = await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { cptCodes: ["99350"] } });
    expect(r.cptUnits).toEqual({});
    const write = calls.find((c) => c.sql.includes("UPDATE superbill") && c.sql.includes("cpt_units = "))!;
    expect(jsonBind(write.values)).toBe("{}");
    // Re-adding the code without touching units bills one unit, not the old two.
    const again = await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { cptCodes: ["99350", "99417"] } });
    expect(again.cptUnits).toEqual({});
    expect(again.billedAmountCents).toBe(10186 + 2383);
  });

  it("keeps the saved units when only the codes change and the code stays", async () => {
    billRow = { cpt_codes: ["99350", "99417"], cpt_units: { "99417": 2 } };
    const r = await updateSuperbill({
      orgId: ORG, id: SB, userId: USER, patch: { cptCodes: ["99350", "99417", "99497"] },
    });
    expect(r.cptUnits).toEqual({ "99417": 2 });
  });
});

/**
 * A re-save never re-dates a bill (0107). The draft's date of service is now
 * the visit's day where the practice is, so for a bill saved before that rule
 * a re-save works out another day than the one stored: the visit's UTC day,
 * which is what the payer holds and echoes in the 835. The header of
 * lib/features/org/org-date.ts says such a bill is not re-dated; writing the
 * new day over it here would fail remittance's date match, with every other
 * test in this file still green.
 *
 * A re-save now writes nothing over the bill at all (persist-draft-once.spec),
 * which keeps its date with everything else.
 */
describe("persistDraft — a re-save keeps the bill's date of service", () => {
  it("writes the date on the first save and nothing on conflict", async () => {
    const draft = await buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
    calls = [];
    await persistDraft({ orgId: ORG, draft, actorUserId: USER });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO superbill ("))!;
    expect(insert.values).toContain(draft.dateOfService);
    expect(insert.sql).toContain("ON CONFLICT (visit_id) DO NOTHING");
    expect(insert.sql).not.toMatch(/date_of_service\s*=/);
  });
});
