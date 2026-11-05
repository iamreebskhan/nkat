/**
 * A practice's rulebook rows that nobody edited follow the library (0130).
 *
 * Seen on production on 4 Nov 2026: generating a rulebook copied each library
 * rule into org_rulebook_row (origin 'source'), the lookup answered from the
 * copy, and the copies kept what the library said before the 3 Nov audit —
 * G0318 as an office code, quotes cut off mid-sentence, no NP/PA rate — for
 * every date of service. Now:
 *
 *   - fetchOrgRule reads only rows a person decided, so the library answers a
 *     machine-written cell itself, for the date of service;
 *   - generateRulebook copies the rule that answers each key today where the
 *     practice is, as app.refresh_rulebook_mirrors() does, and an uploaded
 *     rulebook is compared with that same rule;
 *   - an ingestion refresh rewrites only machine-written rows, never an
 *     uploaded rulebook.
 *
 * These pin what each statement sends; db/test/0008 runs the refresh against
 * Postgres, and the lookups are run on localhost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn(), withBreakglass: vi.fn() }));
vi.mock("@/lib/features/billing/code.service", () => ({ hasAmaLicense: () => false }));

import { withBreakglass, withOrgContext } from "@/lib/db";

import { fetchOrgRule } from "../org-rule.repository";
import { buildComparison, generateRulebook, propagateGlobalRuleToAllOrgRulebooks } from "../rulebook.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEDICARE = "a0000000-0000-4000-8000-000000000401";

let calls: { sql: string; values: unknown[] }[];
let zone: string;

/** The value bound at the `¶` that `re` locates. */
function boundIn(call: { sql: string; values: unknown[] }, re: RegExp): unknown {
  const m = re.exec(call.sql);
  if (!m) throw new Error(`the statement has no ${re}`);
  const at = m.index + m[0].indexOf("¶");
  return call.values[call.sql.slice(0, at).split("¶").length - 1];
}

/** The read of the rule library. */
const libraryRead = () => calls.find((c) => c.sql.includes("FROM payer_rule pr"))!;

const uploadedRows = [
  { payerId: MEDICARE, state: "OH", cptCode: "G0318", attribute: "covered", coverageStatus: "covered", ruleValue: {} },
];

const rulebookRow = {
  id: "rb-1", org_id: ORG, current_version: 1, origin: "generated",
  source_state_codes: ["OH"], source_payer_ids: [MEDICARE], source_cpt_codes: ["G0318"],
  finalized_at: new Date("2026-11-04T12:00:00Z"), finalized_by_user_id: null, notes: null,
};

function fakeTx() {
  const record = (strings: TemplateStringsArray, values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    return sql;
  };
  return {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = record(strings, values);
      if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: zone }]);
      if (sql.includes("FROM payer_rule pr")) return Promise.resolve([]);
      if (sql.includes("INSERT INTO org_rulebook (") || sql.includes("SELECT * FROM org_rulebook ")) {
        return Promise.resolve([rulebookRow]);
      }
      if (sql.includes("FROM org_rulebook_row r")) return Promise.resolve([]);
      if (sql.includes("FROM rulebook_upload")) return Promise.resolve([{ parsed_rows: uploadedRows }]);
      return Promise.reject(new Error(`the fake does not recognise this query: ${sql}`));
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(0);
    },
  };
}

beforeEach(() => {
  calls = [];
  zone = "America/New_York";
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
  vi.mocked(withBreakglass).mockImplementation(async (fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

afterEach(() => vi.useRealTimers());

describe("fetchOrgRule — only a person's decision answers as the rulebook", () => {
  it("leaves machine-written rows (library copies, the AI cache) to the library", async () => {
    await fetchOrgRule({ orgId: ORG, payerId: MEDICARE, state: "OH", code: "G0318", attribute: "covered", dos: "2026-03-12" });
    const read = calls.find((c) => c.sql.includes("FROM org_rulebook_row r"))!;
    expect(read.sql).toMatch(/AND r\.origin <> 'source'\s*ORDER BY/);
    // The old rule let a copy answer at the library's confidence.
    expect(read.sql).not.toMatch(/r\.confidence >=/);
    expect(read.values).not.toContain(0.5);
  });

  it("CONTROL: a person's decisions still rank as before", async () => {
    await fetchOrgRule({ orgId: ORG, payerId: MEDICARE, state: "OH", code: "G0318", attribute: "covered", dos: "2026-03-12" });
    const read = calls.find((c) => c.sql.includes("FROM org_rulebook_row r"))!;
    expect(read.sql).toMatch(
      /\(r\.origin = 'org_override'\) DESC,\s*\(r\.origin = 'analyst'\)\s*DESC,\s*\(r\.origin = 'org_upload'\)\s*DESC/,
    );
  });
});

describe("generateRulebook — copies the rule that answers each key today", () => {
  const generate = () =>
    generateRulebook({ orgId: ORG, byUserId: "u-1", states: ["OH"], payerIds: [MEDICARE], cptCodes: ["G0318"] });

  it("asks for one rule per key, in force on the practice's today", async () => {
    // 23:30 on 4 Nov in New York is already 5 Nov in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T04:30:00Z"));

    await generate();

    expect(libraryRead().sql).toMatch(/SELECT DISTINCT ON \(pr\.payer_id, pr\.state, pr\.code, pr\.attribute\)/);
    expect(boundIn(libraryRead(), /pr\.effective_date <= ¶/)).toBe("2026-11-04");
    expect(boundIn(libraryRead(), /pr\.expiration_date > ¶/)).toBe("2026-11-04");
    expect(libraryRead().sql).toMatch(
      /ORDER BY pr\.payer_id, pr\.state, pr\.code, pr\.attribute,\s*pr\.effective_date DESC, pr\.id DESC/,
    );
  });

  it("no longer takes any open-ended row, a rule not yet in force among them", async () => {
    await generate();
    expect(libraryRead().sql).not.toMatch(/AND pr\.expiration_date IS NULL\s*$/m);
  });

  it("the day follows the practice's own zone, here Honolulu's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T09:30:00Z")); // 23:30 on 4 Nov in Honolulu
    zone = "Pacific/Honolulu";

    await generate();

    expect(boundIn(libraryRead(), /pr\.effective_date <= ¶/)).toBe("2026-11-04");
  });
});

describe("buildComparison — an upload is compared with the rule that answers today", () => {
  it("reads one rule per key, in force on the practice's today, as generation does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T04:30:00Z")); // 23:30 on 4 Nov in New York

    await buildComparison({ orgId: ORG, uploadId: "up-1" });

    expect(libraryRead().sql).toMatch(/SELECT DISTINCT ON \(pr\.payer_id, pr\.state, pr\.code, pr\.attribute\)/);
    expect(boundIn(libraryRead(), /pr\.effective_date <= ¶/)).toBe("2026-11-04");
    expect(boundIn(libraryRead(), /pr\.expiration_date > ¶/)).toBe("2026-11-04");
    // It compared the upload with any open-ended rule, next year's among them.
    expect(libraryRead().sql).not.toMatch(/AND pr\.expiration_date IS NULL\s*$/m);
  });
});

describe("propagateGlobalRuleToAllOrgRulebooks — an ingested rule", () => {
  it("rewrites only machine-written rows, never an uploaded rulebook", async () => {
    await propagateGlobalRuleToAllOrgRulebooks({
      ruleId: "r-1", payerId: MEDICARE, state: "OH", dbAttribute: "covered", cptCode: "G0318",
      coverageStatus: "covered", ruleValue: { answer: "Covered." }, confidence: 0.85, sourceQuote: "q",
    });
    const update = calls.find((c) => c.sql.includes("UPDATE org_rulebook_row"))!;
    expect(update.sql).toMatch(/AND origin = 'source'\s*$/);
    // It used to skip only overrides and payer calls, and relabel an upload 'source'.
    expect(update.sql).not.toMatch(/NOT IN \('org_override', 'analyst'\)/);
    expect(update.sql).not.toMatch(/origin = 'source',/);
  });
});
