/**
 * The superbill code picker's data (audit R21), and what it asks the view for.
 *
 * Two defects on one path. On an unlicensed deployment the picker showed full
 * CPT descriptors (the view selects them raw) while the Rulebook and the
 * sidebar badge said they were redacted. And every row's provenance read
 * "Unsourced", because the view compared created_by with 'crawler' and 'cms'
 * exactly and most of the library is 'extract:*'.
 *
 * prisma is mocked. The mock used to answer every statement with the same two
 * rows, whatever it asked for, so the read's WHERE clause was covered by
 * nothing: the product-line filter, the date-of-service filter, the state and
 * the payer scope could each be deleted, and the default coverage filter
 * widened to include not_covered codes, with all four tests green. It now
 * holds ROWS and evaluates the statement's own WHERE against them, so a
 * predicate that goes missing changes what the picker returns.
 *
 * Each test uses its own payer id to step around the module's 60-second cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../code.service", () => ({ hasAmaLicense: vi.fn() }));

import { prisma } from "@/lib/db";

import { AMA_PLACEHOLDER } from "../code-pure";
import { hasAmaLicense } from "../code.service";
import { getAllowedCodesForPayer, searchAllowedCodes } from "../payer-allowed-codes.service";

let n = 0;
const freshPayer = () => `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
/** The payer under test. Fresh per test, so the 60-second cache cannot answer. */
let payerId: string;
const OTHER_PAYER = "a0000000-0000-4000-8000-0000000000ff";

interface ViewRow {
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  descriptor: string;
  category: string | null;
  code_system: "CPT" | "HCPCS2";
  coverage_status: "covered" | "varies" | "not_covered" | "unknown";
  confidence: string;
  effective_date: Date;
  rule_created_at: Date;
  created_by: string;
  source_doc_id: string;
  source_quote: string | null;
  source_kind: string;
  modifier_required: boolean;
  prior_auth_required: boolean;
  has_frequency_limit: boolean;
  frequency_limit_value: string | null;
  prior_auth_value: string | null;
}

const viewRow = (
  code: string,
  codeSystem: "CPT" | "HCPCS2",
  descriptor: string,
  o: Partial<ViewRow> = {},
): ViewRow => ({
  payer_id: payerId, state: "OH", product_line: "commercial", code, descriptor, category: null,
  code_system: codeSystem, coverage_status: "covered", confidence: "0.85",
  effective_date: new Date("2026-01-01T00:00:00Z"), rule_created_at: new Date("2026-01-02T00:00:00Z"),
  created_by: "extract:coverage-basis-2026-08", source_doc_id: "d", source_quote: null,
  // What the live view derives for every row today.
  source_kind: "unknown",
  modifier_required: false, prior_auth_required: false, has_frequency_limit: false,
  frequency_limit_value: null, prior_auth_value: null,
  ...o,
});

/** What payer_allowed_codes_v holds for this test. */
let rows: ViewRow[];
/** Every statement the service sent, as `[sql, ...values]`. */
let calls: { sql: string; values: unknown[] }[];

/** `text` split on `sep` where it is not inside parentheses. */
function splitOutsideParens(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(from, i).trim());
      from = i + sep.length;
      i = from - 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

/** The value bound at the `¶` inside the first match of `re`, or undefined. */
function boundIn(call: { sql: string; values: unknown[] }, re: RegExp): unknown {
  const m = re.exec(call.sql);
  if (!m) return undefined;
  const at = m.index + m[0].indexOf("¶");
  return call.values[call.sql.slice(0, at).split("¶").length - 1];
}

/** A date column against a 'YYYY-MM-DD' bind, as Postgres compares them. */
const asDay = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/**
 * The rows the read selects, decided by EVALUATING the WHERE clause the service
 * sent against the rows above. Never restated here: a restatement passes
 * whether or not the predicate is still in the statement, which is how this
 * file came to cover none of them. Only the atoms this statement uses are
 * understood — `col = ?`, `col <= ?`, `col = ANY(?::text[])`, `col IS [NOT]
 * NULL`, `TRUE` and parenthesised ORs of those — and anything else throws
 * rather than being guessed at.
 */
function rowsMatching(sql: string, values: unknown[]): ViewRow[] {
  const start = sql.indexOf("WHERE ") + "WHERE ".length;
  const end = sql.indexOf("ORDER BY", start);
  let next = sql.slice(0, start).split("¶").length - 1;
  const take = () => values[next++];
  const atom = (text: string): ((r: ViewRow) => boolean) => {
    const col = (name: string): keyof ViewRow => {
      if (!(name in viewRow("", "CPT", ""))) throw new Error(`no view column "${name}"`);
      return name as keyof ViewRow;
    };
    let m: RegExpExecArray | null;
    if (/^TRUE$/i.test(text)) return () => true;
    if ((m = /^(\w+)\s*= ANY\(¶(?:::\w+(?:\[\])?)?\)$/.exec(text))) {
      const c = col(m[1]!);
      const list = take() as unknown[];
      return (r) => list.includes(r[c]);
    }
    if ((m = /^(\w+) IS (NOT )?NULL$/.exec(text))) {
      const c = col(m[1]!);
      const negated = Boolean(m[2]);
      return (r) => (r[c] === null) !== negated;
    }
    if ((m = /^(\w+)\s*(=|<=|>=) ¶(?:::\w+)?$/.exec(text))) {
      const c = col(m[1]!);
      const value = take();
      if (m[2] === "=") return (r) => r[c] === value;
      return (r) => (m![2] === "<=" ? asDay(r[c]) <= asDay(value) : asDay(r[c]) >= asDay(value));
    }
    throw new Error(`the fake cannot evaluate the picker read's clause: ${text}`);
  };
  const clauses = splitOutsideParens(
    sql.slice(start, end < 0 ? undefined : end).replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim(),
    " AND ",
  ).map((clause) => {
    if (!clause.startsWith("(")) return atom(clause);
    const either = splitOutsideParens(clause.slice(1, -1), " OR ").map(atom);
    return (r: ViewRow) => either.some((p) => p(r));
  });
  return rows.filter((r) => clauses.every((p) => p(r)));
}

beforeEach(() => {
  payerId = freshPayer();
  calls = [];
  rows = [
    viewRow("99491", "CPT", "Chronic care mgmt, physician/QHP"),
    viewRow("G0318", "HCPCS2", "Prolonged home E/M"),
  ];
  vi.mocked(prisma.$queryRaw).mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    return Promise.resolve(rowsMatching(sql, values));
  }) as never);
});

const codesFrom = (list: { code: string }[]) => list.map((r) => r.code);
const readCall = () => calls[calls.length - 1]!;

describe("allowed codes — the AMA gate", () => {
  it("withholds CPT text and keeps HCPCS text on an unlicensed deployment", async () => {
    vi.mocked(hasAmaLicense).mockReturnValue(false);
    const rows = await getAllowedCodesForPayer({ payerId, state: "OH" });
    expect(rows.find((r) => r.code === "99491")!.descriptor).toBe(AMA_PLACEHOLDER);
    expect(rows.find((r) => r.code === "G0318")!.descriptor).toBe("Prolonged home E/M");
  });

  it("shows CPT text under the licence", async () => {
    vi.mocked(hasAmaLicense).mockReturnValue(true);
    const rows = await getAllowedCodesForPayer({ payerId, state: "OH" });
    expect(rows.find((r) => r.code === "99491")!.descriptor).toBe("Chronic care mgmt, physician/QHP");
  });

  it("searches a withheld CPT code by its number only", async () => {
    vi.mocked(hasAmaLicense).mockReturnValue(false);
    const codes = async (query: string) =>
      (await searchAllowedCodes({ payerId, state: "OH", query })).map((r) => r.code);
    // "ama" would otherwise match the placeholder on every CPT code.
    expect(await codes("ama")).toEqual([]);
    expect(await codes("chronic")).toEqual([]);
    expect(await codes("994")).toEqual(["99491"]);
    expect(await codes("prolonged")).toEqual(["G0318"]);
  });
});

describe("allowed codes — provenance", () => {
  it("reads a document extraction as an official source, not the view's 'unknown'", async () => {
    vi.mocked(hasAmaLicense).mockReturnValue(true);
    const rows = await getAllowedCodesForPayer({ payerId, state: "OH" });
    expect(rows.map((r) => r.sourceKind)).toEqual(["crawler", "crawler"]);
  });
});

describe("allowed codes — which rules reach the picker", () => {
  beforeEach(() => {
    vi.mocked(hasAmaLicense).mockReturnValue(true);
  });

  it("keeps a code the payer has marked not_covered out of the autocomplete", async () => {
    // This is what the picker exists for: offered a denied code, the nurse
    // picks it and the claim comes back denied. 'unknown' is not an offer
    // either — there is no rule on file saying the payer pays it.
    rows.push(
      viewRow("36415", "CPT", "Collection of venous blood", { coverage_status: "not_covered" }),
      viewRow("99417", "CPT", "Prolonged outpatient E/M", { coverage_status: "unknown" }),
      viewRow("99490", "CPT", "Chronic care mgmt, staff", { coverage_status: "varies" }),
    );
    const picker = await getAllowedCodesForPayer({ payerId, state: "OH" });
    expect(codesFrom(picker)).toEqual(["99491", "G0318", "99490"]);
  });

  it("CONTROL — 'show all' asks for the denied codes as well, and returns them", async () => {
    rows.push(
      viewRow("36415", "CPT", "Collection of venous blood", { coverage_status: "not_covered" }),
      viewRow("99417", "CPT", "Prolonged outpatient E/M", { coverage_status: "unknown" }),
    );
    const picker = await getAllowedCodesForPayer({ payerId, state: "OH", includeDenied: true });
    expect(codesFrom(picker)).toEqual(expect.arrayContaining(["36415", "99417"]));
  });

  it("fills a Medicare patient's picker from that schedule, not the payer's commercial one", async () => {
    rows.push(
      viewRow("G0068", "HCPCS2", "Home infusion, per visit", { product_line: "medicare_part_b" }),
    );
    const medicare = await getAllowedCodesForPayer({
      payerId, state: "OH", productLine: "medicare_part_b",
    });
    expect(codesFrom(medicare)).toEqual(["G0068"]);
  });

  it("leaves a rule that does not take effect until next quarter out of today's picker", async () => {
    // A back-dated review asks for the rules in force on ITS date of service,
    // which is the other half of the same filter.
    rows.push(
      viewRow("99457", "CPT", "Remote physiologic monitoring", {
        effective_date: new Date("2099-01-01T00:00:00Z"),
      }),
    );
    const today = await getAllowedCodesForPayer({ payerId, state: "OH" });
    expect(codesFrom(today)).not.toContain("99457");

    const backDated = await getAllowedCodesForPayer({ payerId, state: "OH", dos: "2025-06-01" });
    expect(codesFrom(backDated)).toEqual([]);
  });

  it("reads this payer's rules in this state, and no one else's", async () => {
    // The view is global reference data with no RLS — these two predicates are
    // the whole of the scoping, and withOrgContext is not behind them.
    rows.push(
      viewRow("99500", "CPT", "Another payer's code", { payer_id: OTHER_PAYER }),
      viewRow("99501", "CPT", "The same payer, another state", { state: "NC" }),
    );
    const picker = await getAllowedCodesForPayer({ payerId, state: "OH" });
    expect(codesFrom(picker)).toEqual(["99491", "G0318"]);
  });

  it("asks for commercial rules in force today when the caller names neither", async () => {
    // Asserted on the BOUND values, not on the statement's words: a predicate
    // that loses its bind — or takes the wrong one — loses this too.
    //
    // The clock is pinned. The service reads today's date for itself, and this
    // test used to read it again AFTER the call, so a run that straddled
    // midnight UTC compared yesterday's bind with today's date and failed for
    // no reason. Reading it before the call would only narrow that window;
    // pinning closes it. Only Date is faked, so the mocked database's promises
    // still resolve, and midday UTC is the same calendar date from UTC-12 to
    // UTC+11, so the pinned instant cannot itself cross a date line.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
    try {
      await getAllowedCodesForPayer({ payerId, state: "OH" });
      const call = readCall();
      expect(boundIn(call, /\bpayer_id\s*= ¶/)).toBe(payerId);
      expect(boundIn(call, /\bstate\s*= ¶/)).toBe("OH");
      expect(boundIn(call, /\bproduct_line\s*= ¶/)).toBe("commercial");
      expect(boundIn(call, /\beffective_date\s*<= ¶/)).toBe("2026-03-15");
      expect(boundIn(call, /\bcoverage_status\s*= ANY\(¶/)).toEqual(["covered", "varies"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
