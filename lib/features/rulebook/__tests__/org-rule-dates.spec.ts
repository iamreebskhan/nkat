/**
 * The org rulebook and the date of service, both ways (0107).
 *
 * fetchOrgRule compared expires_at with a JS Date, and upsertOrgRule wrote an
 * attestation's expiry DAY into timestamptz as a bare 'YYYY-MM-DD', which is
 * midnight in the database session's zone. So the instant a rule stopped
 * answering moved with the server. Now the date of service is a day, compared
 * from the start of that day where the practice is, and an expiry day is
 * written as the start of that day there.
 *
 * AT TIME ZONE is Postgres's to evaluate, so these pin what the statements
 * bind and how they compare; the lookups themselves are run on localhost.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { fetchOrgRule, upsertOrgRule } from "../org-rule.repository";

const ORG = "11111111-1111-4111-8111-111111111111";
const PAYER = "a0000000-0000-4000-8000-000000000302";

let calls: { sql: string; values: unknown[] }[];
let answer: unknown[];

/** The value bound at the `¶` that `re` locates. */
function boundIn(call: { sql: string; values: unknown[] }, re: RegExp): unknown {
  const m = re.exec(call.sql);
  if (!m) throw new Error(`the statement has no ${re}`);
  const at = m.index + m[0].indexOf("¶");
  return call.values[call.sql.slice(0, at).split("¶").length - 1];
}

beforeEach(() => {
  calls = [];
  answer = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join("¶"), values });
        return Promise.resolve(strings.join("¶").includes("org_rulebook (") ? [{ id: "rb-1" }] : answer);
      },
      $executeRaw: () => Promise.resolve(1),
    }),
  );
});

describe("fetchOrgRule — still in force on the date of service", () => {
  const fetch = () =>
    fetchOrgRule({ orgId: ORG, payerId: PAYER, state: "OH", code: "99350", attribute: "covered", dos: "2026-09-22" });

  it("compares expires_at with the start of the date of service in the org's own zone", async () => {
    await fetch();
    const read = calls.find((c) => c.sql.includes("FROM org_rulebook_row r"))!;
    expect(read.sql).toContain("JOIN org o ON o.id = r.org_id");
    expect(read.sql).toMatch(/r\.expires_at > \(¶::date::timestamp AT TIME ZONE o\.timezone\)/);
    expect(boundIn(read, /r\.expires_at > \(¶/)).toBe("2026-09-22");
  });

  it("gives the day of the last edit where the practice is, read from a DATE", async () => {
    answer = [{
      row_id: "row-1", attribute: "covered", rule_value: {}, coverage_status: "covered", confidence: "0.6",
      origin: "analyst", source_quote: null, expires_at: null,
      last_edited_at: new Date("2026-07-15T01:30:00Z"),
      // (01:30 UTC on the 15th AT TIME ZONE America/New_York)::date
      last_edited_day: new Date("2026-07-14T00:00:00Z"),
      source_attestation_id: "att-1", source_payer_rule_id: null,
    }];
    const hit = await fetch();
    expect(hit?.lastEditedDay).toBe("2026-07-14");
    const read = calls.find((c) => c.sql.includes("FROM org_rulebook_row r"))!;
    expect(read.sql).toMatch(/\(r\.last_edited_at AT TIME ZONE o\.timezone\)::date AS last_edited_day/);
  });
});

describe("upsertOrgRule — an attestation's expiry day", () => {
  const write = (expiresAt: Date | string | null) =>
    upsertOrgRule({
      orgId: ORG, payerId: PAYER, state: "OH", code: "99350", attribute: "covered",
      coverageStatus: "covered", ruleValue: {}, confidence: 0.6, origin: "analyst",
      sourceQuote: null, expiresAt, sourceAttestationId: "att-1", byUserId: null, preserveOverride: false,
    });
  const insert = () => calls.find((c) => c.sql.includes("INSERT INTO org_rulebook_row"))!;
  const instantBound = () => boundIn(insert(), /COALESCE\(¶::timestamptz/);
  const dayBound = () => boundIn(insert(), /\(¶::date::timestamp AT TIME ZONE/);

  it("writes a day as the start of that day where the practice is", async () => {
    await write("2027-01-18");
    expect(dayBound()).toBe("2027-01-18");
    expect(instantBound()).toBeNull();
    expect(insert().sql).toMatch(
      /\(¶::date::timestamp AT TIME ZONE\s*\(SELECT o\.timezone FROM org o WHERE o\.id = ¶::uuid\)\)/,
    );
    expect(boundIn(insert(), /WHERE o\.id = ¶/)).toBe(ORG);
  });

  it("CONTROL: an instant is stored as given, with no day", async () => {
    await write(new Date("2027-01-18T05:00:00Z"));
    expect(instantBound()).toBe("2027-01-18T05:00:00.000Z");
    expect(dayBound()).toBeNull();
  });

  it("CONTROL: no expiry is no expiry", async () => {
    await write(null);
    expect(instantBound()).toBeNull();
    expect(dayBound()).toBeNull();
  });
});
