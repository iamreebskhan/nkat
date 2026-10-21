/**
 * The date of service on a bill is the day the visit happened where it
 * happened, not its UTC day.
 *
 * The draft took (start_time ?? scheduled_start ?? now).toISOString()
 * .slice(0, 10). For a practice in New York every visit that starts after
 * 8 pm EDT (7 pm EST) was billed as the next day: that day picked the payer's
 * fee-schedule row, was stored on the bill and sent on the claim, and made the
 * 835 date match fail. toISOString ignores the process zone, so this happened
 * on every machine, CI included.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text, as pricing.spec.ts
 * does, with two differences against test theatre:
 *
 *   - the visit row carries the org's zone only when the statement selects it
 *     from a joined org, as Postgres would. A fix that forgets the SELECT item
 *     or the join gets a row with no zone, and fails loudly;
 *   - the payer's rates are ROWS with an effective window, and the rate read
 *     is answered by the dates it actually binds. The fee schedule below
 *     changes on the 23rd, so the day decides the price.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/billing/predict-superbill.service", () => ({
  predictSuperbill: vi.fn().mockResolvedValue(null),
}));

import { withOrgContext } from "@/lib/db";

import { buildDraftFromVisit } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
const UHC_OH = "a0000000-0000-4000-8000-000000000302";

/** The org row the visit belongs to; a test may move the practice. */
let org: { id: string; timezone: string };

interface RateRow {
  code: string;
  id: string;
  value: Record<string, unknown>;
  effective_date: string;
  expiration_date: string | null;
}

/**
 * UHC Community Plan Ohio's 99349, with a schedule change on 23 Sep. A visit
 * on the 22nd is priced at the old rate; one on the 23rd at the new.
 */
const RATES: RateRow[] = [
  { code: "99349", id: "rule-99349-old", value: { rate: 70.13 }, effective_date: "2024-01-01", expiration_date: "2026-09-23" },
  { code: "99349", id: "rule-99349-new", value: { rate: 75.0 }, effective_date: "2026-09-23", expiration_date: null },
];

let visit: { start_time: Date | null; scheduled_start: Date | null };
let calls: { sql: string; values: unknown[] }[] = [];

/**
 * The visit row as the statement asks for it. org_timezone comes back only if
 * the statement selects o.timezone AS org_timezone from an org joined on the
 * visit's org; anything else about the row is what pricing.spec.ts uses.
 */
function visitRow(sql: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: VISIT, status: "documented", patient_id: "p1", is_telehealth: false,
    cpt_codes_assigned: ["99349"], cpt_units: {}, icd10_codes: ["C34.10"], modifiers: [],
    scheduled_start: visit.scheduled_start, start_time: visit.start_time,
    primary_payer_id: UHC_OH, primary_member_id: "M1", primary_diagnosis_icd10: null,
    clinician_npi: "1234567893", credential: "NP", org_npi: null, full_name: "Jane NP",
    coverage_state: "OH", place_of_service_code: "12", pos_facility: "non_facility",
    coding_basis: "established_patient_home",
  };
  if (/\bo\.timezone AS org_timezone\b/.test(sql) && /\bJOIN org o ON o\.id = v\.org_id\b/.test(sql)) {
    row.org_timezone = org.timezone;
  }
  return row;
}

/** The value bound right after the text `before` in the statement. */
function boundAfter(strings: TemplateStringsArray, values: unknown[], before: RegExp): unknown {
  const i = strings.findIndex((s) => before.test(s));
  if (i < 0 || i >= values.length) throw new Error(`the rate read binds nothing after ${before}`);
  return values[i];
}

/**
 * The rate read, answered by its own date binds: in force on the DOS
 * (effective_date <= dos, expiration_date NULL or > dos), then one row per code.
 */
function rateRows(strings: TemplateStringsArray, values: unknown[]) {
  const from = boundAfter(strings, values, /pr\.effective_date <= $/);
  const until = boundAfter(strings, values, /pr\.expiration_date > $/);
  for (const d of [from, until]) {
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`the rate read bound ${String(d)} into ::date; it must be a YYYY-MM-DD day`);
    }
  }
  const asked = values.find(Array.isArray) as string[];
  return RATES.filter(
    (r) =>
      asked.includes(r.code) &&
      r.effective_date <= (from as string) &&
      (r.expiration_date === null || r.expiration_date > (until as string)),
  );
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM visit v") && sql.includes("clinician_npi")) return Promise.resolve([visitRow(sql)]);
    if (sql.includes("SELECT payer_type FROM payer")) return Promise.resolve([{ payer_type: "medicaid_mco" }]);
    if (sql.includes("FROM payer_rule pr")) return Promise.resolve(rateRows(strings, values));
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const build = () => buildDraftFromVisit({ orgId: ORG, visitId: VISIT });
const rateRead = () => calls.find((c) => c.sql.includes("FROM payer_rule pr"))!;

beforeEach(() => {
  calls = [];
  org = { id: ORG, timezone: "America/New_York" };
  visit = { start_time: null, scheduled_start: null };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildDraftFromVisit — the date of service is the practice's day", () => {
  it("CONTROL: a visit started at 8:30 pm EDT on 22 Sep is billed on the 22nd, not the 23rd", async () => {
    visit.start_time = new Date("2026-09-23T00:30:00Z");
    const d = await build();
    expect(d.dateOfService).toBe("2026-09-22");
  });

  it("CONTROL: its payer rate is looked up on the 22nd, and priced at the 22nd's schedule", async () => {
    visit.start_time = new Date("2026-09-23T00:30:00Z");
    const d = await build();
    const q = rateRead();
    expect(q.values).toContain("2026-09-22");
    expect(q.values).not.toContain("2026-09-23");
    // The old schedule, in force on the 22nd. On the 23rd it would be 7500.
    expect(d.billedAmountCents).toBe(7013);
    expect(d.pricing.lines[0]).toMatchObject({ code: "99349", payerRuleId: "rule-99349-old" });
  });

  it("CONTROL: the org's own zone decides: 10:30 pm PDT in Los Angeles is the 22nd", async () => {
    // 05:30Z on the 23rd, which is already 1:30 am on the 23rd in New York:
    // read in any zone but the practice's, it is billed on the 23rd, at 7500.
    org = { ...org, timezone: "America/Los_Angeles" };
    visit.start_time = new Date("2026-09-23T05:30:00Z");
    const d = await build();
    expect(d.dateOfService).toBe("2026-09-22");
    expect(rateRead().values).toContain("2026-09-22");
    expect(rateRead().values).not.toContain("2026-09-23");
    expect(d.billedAmountCents).toBe(7013);
  });

  it("CONTROL: in winter the offset is EST's: 11:30 pm EST on 14 Jan is the 14th", async () => {
    // 04:30Z on 15 Jan. An EDT offset kept all year (UTC-4) would make it
    // 12:30 am on the 15th, as the UTC day does.
    visit.start_time = new Date("2026-01-15T04:30:00Z");
    const d = await build();
    expect(d.dateOfService).toBe("2026-01-14");
    expect(rateRead().values).toContain("2026-01-14");
  });

  it("CONTROL: a scheduled time is read the same way when the visit recorded no start", async () => {
    visit.scheduled_start = new Date("2026-09-23T00:30:00Z");
    expect((await build()).dateOfService).toBe("2026-09-22");
  });

  it("CONTROL: with no time recorded at all, today is the practice's today", async () => {
    // 10 pm EDT on 22 Sep; UTC is already on the 23rd.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T02:00:00Z"));
    const d = await build();
    expect(d.dateOfService).toBe("2026-09-22");
    expect(rateRead().values).toContain("2026-09-22");
  });

  it("twin: a daytime visit keeps its day, so this is no blanket shift back", async () => {
    // 11 am EDT on 22 Sep. Passes before and after the fix.
    visit.start_time = new Date("2026-09-22T15:00:00Z");
    const d = await build();
    expect(d.dateOfService).toBe("2026-09-22");
    expect(d.billedAmountCents).toBe(7013);
  });

  it("twin: a visit started just after midnight EDT on the 23rd is the 23rd, at the new rate", async () => {
    // 12:30 am EDT on 23 Sep (04:30Z). Passes before and after the fix.
    visit.start_time = new Date("2026-09-23T04:30:00Z");
    const d = await build();
    expect(d.dateOfService).toBe("2026-09-23");
    expect(d.billedAmountCents).toBe(7500);
  });
});
