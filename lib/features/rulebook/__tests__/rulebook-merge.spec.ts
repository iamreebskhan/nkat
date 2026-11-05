/**
 * Merging an uploaded rulebook, and editing a rule's coverage (5 Nov 2026).
 *
 * Seen on localhost after the 0130 fix:
 *   - applying an upload to a rulebook that already held any of its cells
 *     (every cell, once one was generated) broke the unique index and rolled
 *     the whole merge back: "Something went wrong";
 *   - "Use Pallio" stored Pallio's rule as the practice's own (org_upload),
 *     frozen as the library read that day and answering every date with it;
 *   - a file's 'prior_auth' never met the library's 'prior_auth_required',
 *     and a row stored under it never answered a lookup;
 *   - changing a cell's coverage kept the library's wording: "Covered" above
 *     "Aetna publishes no coverage decision for this code".
 *
 * These pin what each statement sends; the merges and edits are run on
 * localhost against Postgres.
 */
import { type NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn(), withBreakglass: vi.fn() }));
vi.mock("@/lib/features/billing/code.service", () => ({ hasAmaLicense: () => false }));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/observability/sentry", () => ({ reportError: vi.fn() }));

import { POST as mergeRoute } from "@/app/api/rulebook/merge/route";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";

import { applyEdits, buildComparison, mergeUploadedRulebook } from "../rulebook.service";
import type { MergeDecision } from "../rulebook.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "22222222-2222-4222-8222-222222222222";
const AETNA = "a0000000-0000-4000-8000-000000000101";
const RULE_99350 = "c0000000-0000-4000-8000-000000009935";

let calls: { sql: string; values: unknown[] }[];
let held: { payer_id: string | null; state: string; cpt_code: string; attribute: string; origin: string }[];
let library: Record<string, unknown>[];
let uploaded: Record<string, unknown>[];

function fakeTx() {
  const record = (strings: TemplateStringsArray, values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    return sql;
  };
  return {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = record(strings, values);
      if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: "America/New_York" }]);
      if (sql.includes("INSERT INTO org_rulebook (")) return Promise.resolve([{ id: "rb-1" }]);
      if (sql.includes("FROM org_rulebook_row r") && sql.includes("jsonb_to_recordset")) return Promise.resolve(held);
      if (sql.includes("FROM payer_rule pr")) return Promise.resolve(library);
      if (sql.includes("FROM rulebook_upload")) return Promise.resolve([{ parsed_rows: uploaded }]);
      return Promise.reject(new Error(`the fake does not recognise this query: ${sql}`));
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(1);
    },
  };
}

/** The cells a write statement binds (its jsonb_to_recordset parameter). */
function cellsOf(call: { sql: string; values: unknown[] }): Record<string, unknown>[] {
  const json = call.values.find((v) => typeof v === "string" && v.startsWith("[{"));
  return JSON.parse(json as string);
}

const update = () => calls.find((c) => c.sql.includes("UPDATE org_rulebook_row r SET"))!;
const insert = () => calls.find((c) => c.sql.includes("INSERT INTO org_rulebook_row"))!;

const decision = (over: Partial<MergeDecision>): MergeDecision => ({
  payerId: AETNA, state: "OH", cptCode: "99350", attribute: "covered",
  coverageStatus: "covered", ruleValue: { answer: "Covered per our contract" }, ...over,
});

const merge = (decisions: MergeDecision[]) =>
  mergeUploadedRulebook({ orgId: ORG, uploadId: "up-1", byUserId: "u-1", decisions });

beforeEach(() => {
  calls = [];
  held = [];
  library = [];
  uploaded = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
  vi.mocked(requireAuth).mockResolvedValue({ userId: "u-1", orgId: ORG, permissions: ["knowledge.edit"] } as never);
});

describe("mergeUploadedRulebook — a cell the rulebook already holds", () => {
  it("replaces its library copy or earlier upload, then inserts only the cells it lacks", async () => {
    await merge([decision({})]);

    expect(update().sql).toMatch(/AND r\.origin IN \('source', 'org_upload'\)\s*$/);
    expect(insert().sql).toMatch(/WHERE NOT EXISTS \(/);
    // It inserted every decision blind, one statement each.
    expect(calls.filter((c) => c.sql.includes("INSERT INTO org_rulebook_row"))).toHaveLength(1);
    expect(insert().sql).not.toMatch(/VALUES \(/);
  });

  it("matches a cell with no payer too: the unique index never matches NULLs", async () => {
    await merge([decision({ payerId: null })]);
    expect(update().sql).toMatch(/r\.payer_id IS NOT DISTINCT FROM d\.payer_id/);
    expect(insert().sql).toMatch(/r\.payer_id IS NOT DISTINCT FROM d\.payer_id/);
    expect(cellsOf(insert())[0]).toMatchObject({ payer_id: null });
  });

  it("leaves a cell someone edited or confirmed with the payer, and counts it", async () => {
    held = [{ payer_id: AETNA, state: "OH", cpt_code: "99350", attribute: "covered", origin: "org_override" }];

    const r = await merge([decision({ use: "library" }), decision({ cptCode: "99349" })]);

    expect(r).toEqual({ merged: 1, fromLibrary: 0, kept: 1 });
    expect(cellsOf(update()).map((c) => c.cpt_code)).toEqual(["99349"]);
    expect(cellsOf(insert()).map((c) => c.cpt_code)).toEqual(["99349"]);
  });

  it("writes one row per cell when the same cell comes twice: the last decision", async () => {
    await merge([decision({ coverageStatus: "varies" }), decision({ coverageStatus: "not_covered" })]);
    expect(cellsOf(insert())).toHaveLength(1);
    expect(cellsOf(insert())[0]).toMatchObject({ coverage_status: "not_covered" });
  });

  it("marks a rulebook the file was merged into 'merged', and a new one 'uploaded'", async () => {
    await merge([decision({})]);
    const rb = calls.find((c) => c.sql.includes("INSERT INTO org_rulebook ("))!;
    expect(rb.sql).toMatch(/VALUES \(¶::uuid, 'uploaded'/);
    expect(rb.sql).toMatch(/ON CONFLICT \(org_id\) DO UPDATE SET\s*origin = 'merged'/);
  });
});

describe("mergeUploadedRulebook — \"Use Pallio\" keeps a copy that follows the library", () => {
  it("stores the rule in force today as a library copy, not the values the page sent", async () => {
    library = [{
      payer_id: AETNA, state: "OH", code: "99350", attribute: "covered",
      rule_value: { answer: "Covered under the 2026 schedule." }, coverage_status: "covered",
      confidence: "0.85", rule_id: RULE_99350, source_quote: "Home visit codes are covered.",
    }];

    const r = await merge([decision({ use: "library", coverageStatus: "varies", ruleValue: { answer: "stale" } })]);

    expect(r).toEqual({ merged: 1, fromLibrary: 1, kept: 0 });
    expect(cellsOf(insert())[0]).toEqual({
      payer_id: AETNA, state: "OH", cpt_code: "99350", attribute: "covered", origin: "source",
      rule_value: { answer: "Covered under the 2026 schedule." }, coverage_status: "covered",
      confidence: 0.85, source_payer_rule_id: RULE_99350, source_quote: "Home visit codes are covered.",
    });
    // The library read is the one generation uses: one rule per key, in force today.
    expect(calls.find((c) => c.sql.includes("FROM payer_rule pr"))!.sql).toMatch(/SELECT DISTINCT ON/);
  });

  it("stores the gap generation writes when no rule is in force today", async () => {
    await merge([decision({ use: "library" })]);
    expect(cellsOf(insert())[0]).toMatchObject({
      origin: "source", rule_value: {}, coverage_status: "unknown", confidence: 0, source_payer_rule_id: null,
    });
  });

  it("CONTROL: the practice's own value is still its own", async () => {
    await merge([decision({ use: "upload" }), decision({ cptCode: "99349" })]);
    for (const c of cellsOf(insert())) {
      expect(c).toMatchObject({ origin: "org_upload", coverage_status: "covered", rule_value: { answer: "Covered per our contract" } });
    }
  });
});

describe("attribute names — the file's short ones become the library's", () => {
  it("stores an upload's 'prior_auth' as 'prior_auth_required', which the lookup reads", async () => {
    await merge([decision({ attribute: "prior_auth" }), decision({ attribute: "telehealth" })]);
    expect(cellsOf(insert()).map((c) => c.attribute)).toEqual(["prior_auth_required", "telehealth_allowed"]);
  });

  it("compares the file's 'prior_auth' with the library's 'prior_auth_required' rule", async () => {
    uploaded = [{ payerId: AETNA, state: "OH", cptCode: "99350", attribute: "prior_auth", coverageStatus: "not_covered", ruleValue: {} }];
    library = [{
      payer_id: AETNA, state: "OH", code: "99350", attribute: "prior_auth_required",
      rule_value: {}, coverage_status: "not_covered", confidence: "0.8", rule_id: RULE_99350, source_quote: null,
    }];

    const rows = await buildComparison({ orgId: ORG, uploadId: "up-1" });

    // It came back twice: the upload's row unverified, the library's new.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attribute: "prior_auth_required", outcome: "match" });
  });

  it("marks a cell the practice already decided before anyone applies", async () => {
    uploaded = [{ payerId: AETNA, state: "OH", cptCode: "99350", attribute: "covered", coverageStatus: "covered", ruleValue: {} }];
    held = [{ payer_id: AETNA, state: "OH", cpt_code: "99350", attribute: "covered", origin: "analyst" }];

    const rows = await buildComparison({ orgId: ORG, uploadId: "up-1" });

    expect(rows[0]).toMatchObject({ keptAs: "analyst" });
  });
});

describe("POST /api/rulebook/merge", () => {
  const post = (decisions: unknown[]) =>
    mergeRoute(
      new Request("http://localhost/api/rulebook/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: UPLOAD, decisions }),
      }) as unknown as NextRequest,
    );

  it("takes a 'Use Pallio' pick as one", async () => {
    const res = await post([{ ...decision({}), use: "library" }]);
    expect(res.status).toBe(200);
    expect(cellsOf(insert())[0]).toMatchObject({ origin: "source" });
  });

  it("takes an attribute under either name, and refuses one under neither", async () => {
    expect((await post([decision({ attribute: "prior_auth" })])).status).toBe(200);
    expect((await post([decision({ attribute: "prior_auth_required" })])).status).toBe(200);
    calls = [];
    expect((await post([decision({ attribute: "colour" })])).status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe("applyEdits — a new coverage drops the wording of the old one", () => {
  const libraryValue = {
    answer: "Aetna publishes no code-level coverage determination for this code.",
    source: "Aetna Clinical Policy Bulletin Notes, read 2026-08-11",
    notes: "Confirmed on the provider line",
  };

  it("keeps only the editor's fields, and no quote, when the stored coverage differs", async () => {
    await applyEdits({ orgId: ORG, byUserId: "u-1", edits: [{ rowId: "row-1", coverageStatus: "covered", ruleValue: libraryValue }] });

    const edit = calls.find((c) => c.sql.includes("UPDATE org_rulebook_row SET"))!;
    expect(edit.sql).toMatch(/rule_value = CASE WHEN coverage_status = ¶\s*THEN ¶::jsonb\s*ELSE ¶::jsonb\s*END/);
    expect(edit.sql).toMatch(/source_quote = CASE WHEN coverage_status = ¶ THEN source_quote END/);
    expect(edit.values).toContain(JSON.stringify(libraryValue));
    expect(edit.values).toContain(JSON.stringify({ notes: "Confirmed on the provider line" }));
  });

  it("makes an edited payer call the practice's own: no expiry, no link to the attestation", async () => {
    await applyEdits({ orgId: ORG, byUserId: "u-1", edits: [{ rowId: "row-1", coverageStatus: "covered", ruleValue: {} }] });

    const edit = calls.find((c) => c.sql.includes("UPDATE org_rulebook_row SET"))!;
    // It kept both: the lookup dropped the edit when the call expired, and a void deleted it.
    expect(edit.sql).toMatch(/origin = 'org_override',\s*expires_at = NULL,\s*source_attestation_id = NULL,/);
  });
});
