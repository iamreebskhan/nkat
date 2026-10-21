/**
 * A visit must not be attestable with an empty note.
 *
 * On the 20 Aug 2026 client walkthrough a visit was signed and submitted for
 * billing with the Documentation box completely empty, in front of the client,
 * seconds after he said every visit needs a note for audit. The local database
 * holds 207 more in the same state — nearly all created by the smoke suite,
 * which asserted the sign-off succeeded and so pinned the defect as correct.
 *
 * These tests cover both halves: the predicate that decides what "empty" means
 * for a ProseMirror document, and the guard in transitionVisit that uses it.
 * The control cases matter as much as the failures — a guard that also blocks a
 * genuinely documented visit stops all billing.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text, matching
 * document-lock.spec.ts.
 *
 * FOR ANYONE EDITING THE GUARD'S SQL IN visit.service.ts. The transitionVisit
 * cases here do not read a canned row: the fake cuts filled_sections,
 * has_vitals and missing_required out of the statement the service actually
 * sent and runs them over modelled rows. It finds them by five spellings —
 * ` AS filled_sections`, ` AS has_vitals`, ` AS missing_required`, a
 * `FROM <table> <alias> LEFT JOIN <table> <alias> ON … WHERE ` shape for the
 * required-section subquery, and the literal `AND t.is_required` that starts
 * the slice of its WHERE this file evaluates. A rewrite that drops or renames
 * one of them does not silently pass: the extractor throws, and every case
 * that goes through the guard — nearly all of this file, 48 of 64 when the
 * is_required filter is removed — fails at once with a message naming the
 * anchor it could not find ("the guard no longer filters on t.is_required").
 * That is deliberate: a statement this file cannot evaluate must fail rather
 * than be answered with a canned value. It does mean that reshaping the SQL
 * requires keeping those spellings, or updating the extractors below in the
 * same change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { noteIsEmpty } from "../visit-pure";
import { transitionVisit } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
/** Another visit in the same org, whose rows must never satisfy this one. */
const OTHER_VISIT = "e0000000-0000-4000-8000-00000000000b";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("noteIsEmpty", () => {
  it("treats a missing or blank column as empty", () => {
    expect(noteIsEmpty(null)).toBe(true);
    expect(noteIsEmpty(undefined)).toBe(true);
    expect(noteIsEmpty("")).toBe(true);
    expect(noteIsEmpty("   \n  ")).toBe(true);
  });

  it("treats the document page's own empty-doc fallback as empty", () => {
    // app/(platform)/visits/[id]/document/page.tsx serialises exactly this
    // when the editor was never touched.
    expect(noteIsEmpty('{"type":"doc","content":[]}')).toBe(true);
  });

  it("treats a doc holding only empty paragraphs as empty", () => {
    expect(
      noteIsEmpty('{"type":"doc","content":[{"type":"paragraph"}]}'),
    ).toBe(true);
    expect(
      noteIsEmpty(
        '{"type":"doc","content":[{"type":"paragraph"},{"type":"paragraph","content":[]}]}',
      ),
    ).toBe(true);
  });

  it("treats whitespace-only text nodes as empty", () => {
    expect(
      noteIsEmpty(
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"   "}]}]}',
      ),
    ).toBe(true);
  });

  it("counts real prose as documented", () => {
    expect(
      noteIsEmpty(
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"HPI: dyspnea on exertion."}]}]}',
      ),
    ).toBe(false);
  });

  it("counts text nested inside headings and lists as documented", () => {
    expect(
      noteIsEmpty(
        '{"type":"doc","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Oxycodone 10mg"}]}]}]}]}',
      ),
    ).toBe(false);
  });

  it("counts a non-text leaf such as an image as documented", () => {
    expect(
      noteIsEmpty('{"type":"doc","content":[{"type":"image","attrs":{"src":"x"}}]}'),
    ).toBe(false);
  });

  it("does not count a stray hard break as documentation", () => {
    expect(
      noteIsEmpty(
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"hardBreak"}]}]}',
      ),
    ).toBe(true);
  });

  it("counts legacy plain text as documented", () => {
    expect(noteIsEmpty("Patient seen at home, comfortable.")).toBe(false);
  });
});

let currentStatus: string;
let currentNote: string | null;
/** Diagnoses recorded on the visit (visit.icd10_codes length). */
let currentDx: number;
/** The visit's clinician of record, and the signer's recorded credential. */
let currentClinician: string | null;
let currentCred: string | null;
/**
 * The visit's telehealth flag and consent acknowledgment (audit R22). Left
 * undefined by default, as every row before this guard had them, so the
 * existing cases exercise an in-person visit.
 */
let currentTele: boolean | null | undefined;
let currentConsent: boolean | null | undefined;
/**
 * The band the visit's type bills as (audit R18). Undefined by default, as the
 * rows before this guard had it, so the existing cases bill as before.
 */
let currentBasis: string | null | undefined;
/**
 * visit.total_minutes and visit.acp_minutes. Undefined by default, as the rows
 * before the ACP guard had them, so the existing cases sign as before.
 */
let currentTotal: number | null | undefined;
let currentAcp: number | null | undefined;
/**
 * visit.note_template_id. The guard's COALESCE resolves the note to this pin,
 * else to the org's active template.
 */
let currentPin: string | null;
/** A pin another session writes between the guard's read and the sign UPDATE. */
let raceAfterGuard: string | null;
const ACTIVE_TEMPLATE = "72000000-0000-4000-8000-000000000002";
const V1_TEMPLATE = "71000000-0000-4000-8000-000000000001";
let calls: { sql: string; values: unknown[] }[] = [];

// ---------------------------------------------------------------------------
// The tables the guard reads, modelled as rows — and the guard's own SQL, run
// over them.
//
// The three columns the sign guard decides on (filled_sections, has_vitals and
// missing_required) used to be absent from this fake's row, so the statement
// that computes them was never evaluated: the tests below asserted its TEXT.
// That let a blank-but-present required section, or a visit_vitals row holding
// no readings, be made to satisfy a signature with the whole suite green.
//
// Nothing here restates the rule. The fake holds rows; the expressions are cut
// out of the statement the service actually sent and translated from SQL's
// spelling into JavaScript's, so a predicate that is deleted, narrowed or
// widened is deleted, narrowed or widened here too. The translator understands
// a small grammar and THROWS on anything outside it, because a statement this
// cannot evaluate must fail the test rather than be answered with a canned
// value — that is the defect being closed.
// ---------------------------------------------------------------------------

/** note_template_section, as the org's template declares a section. */
interface TemplateSection {
  section_key: string;
  label: string;
  /** 'vitals' is judged by the readings; anything else by its own content. */
  kind: string;
  is_required: boolean;
  not_required_for_visit_types: string[];
  sort_order: number;
}
/** visit_note_section — one row per section the note has ever saved. */
interface NoteSection {
  id: string | null;
  visit_id: string | null;
  section_key: string | null;
  is_empty: boolean | null;
}
/** visit_vitals — the ten nullable readings the guard counts. */
type VitalsRow = Record<string, unknown>;

let template: TemplateSection[];
let noteSections: NoteSection[];
let vitalsRows: VitalsRow[];
let currentVisitType: string;

/** The LEFT JOIN miss: every column of `s` is NULL. */
const NO_SECTION_ROW: NoteSection = {
  id: null,
  visit_id: null,
  section_key: null,
  is_empty: null,
};

const visitRow = () => ({
  id: VISIT,
  org_id: ORG,
  visit_type: currentVisitType,
  is_telehealth: currentTele ?? null,
});

const tables = (): Record<string, unknown[]> => ({
  note_template_section: template,
  visit_note_section: noteSections,
  visit_vitals: vitalsRows,
});

const rows = (name: string) => {
  const t = tables()[name];
  if (!t) throw new Error(`the guard read a table this test does not model: ${name}`);
  return t;
};
const coalesce = (...xs: unknown[]) => xs.find((x) => x != null) ?? null;
/**
 * SQL's `needle = ANY (haystack)`, in JavaScript's two-valued logic where
 * Postgres has three. On a NULL array Postgres answers NULL, so the guard's
 * `NOT (v.visit_type = ANY (t.not_required_for_visit_types))` is NULL and the
 * row is dropped from the WHERE — the section is NOT reported missing. Here
 * the same expression is false, negated to true, and the section IS reported
 * missing: opposite answers. The translation is faithful only because the one
 * array in the evaluated slice is declared
 * `not_required_for_visit_types TEXT[] NOT NULL DEFAULT '{}'`
 * (db/migrations/0088_visit_note_structure.sql:117), so it is never NULL. If
 * that column ever becomes nullable this predicate must be revisited, or the
 * spec will demand a section Postgres would have exempted.
 */
const anyOf = (haystack: unknown, needle: unknown) =>
  Array.isArray(haystack) && haystack.includes(needle);
const numNonnulls = (...xs: unknown[]) => xs.filter((x) => x != null).length;

/** The whole parenthesised group opening at `open`, counted not matched. */
function balanced(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i;
  }
  throw new Error("unbalanced expression in the guard's statement");
}

/** `EXISTS (SELECT 1 FROM x a WHERE p)` → a scan of the modelled table x. */
function expandExists(js: string): string {
  const at = js.indexOf("EXISTS (");
  const open = js.indexOf("(", at);
  const close = balanced(js, open);
  const inner = js.slice(open + 1, close);
  const m = inner.match(/^\s*SELECT 1 FROM (\w+) (\w+) WHERE ([\s\S]+)$/);
  if (!m) throw new Error(`unsupported EXISTS subquery: ${inner}`);
  return (
    js.slice(0, at) +
    `rows("${m[1]}").some(function (${m[2]}) { return (${m[3]}); })` +
    js.slice(close + 1)
  );
}

/** SQL's spelling of a boolean expression, in JavaScript's. */
function toJs(sql: string): string {
  let js = sql.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 8 && js.includes("EXISTS ("); i++) js = expandExists(js);
  js = js.replace(/CASE WHEN ([\s\S]+?) THEN ([\s\S]+?) ELSE ([\s\S]+?) END/g, "(($1) ? ($2) : ($3))");
  js = js.replace(/num_nonnulls\(/gi, "numNonnulls(");
  js = js.replace(/COALESCE\(/gi, "coalesce(");
  js = js.replace(/('[^']*'|[\w.]+) = ANY\s*\(\s*([\w.]+)\s*\)/g, "anyOf($2, $1)");
  js = js.replace(/([\w.]+) IS NOT NULL/g, "($1 != null)");
  js = js.replace(/([\w.]+) IS NULL/g, "($1 == null)");
  js = js.replace(/\bAND\b/g, "&&").replace(/\bOR\b/g, "||").replace(/\bNOT\b\s*/g, "!");
  js = js.replace(/([^<>!=])=([^=])/g, "$1===$2");
  const left = js.match(
    /\b(SELECT|FROM|WHERE|ANY|CASE|WHEN|THEN|ELSE|END|EXISTS|LIMIT|IS|AND|OR|NOT|BETWEEN|LIKE|ORDER|JOIN)\b/,
  );
  if (left) {
    throw new Error(`the guard uses SQL this test cannot evaluate (${left[0]}): ${js}`);
  }
  return js;
}

/** Compile one SQL boolean expression over the named row aliases. */
function predicate(sql: string, aliases: string[]) {
  const fn = new Function(
    ...aliases,
    "rows",
    "coalesce",
    "anyOf",
    "numNonnulls",
    `return Boolean(${toJs(sql)});`,
  ) as (...a: unknown[]) => boolean;
  return (...vals: unknown[]) => fn(...vals, rows, coalesce, anyOf, numNonnulls);
}

/** The statement with its comments stripped and its whitespace collapsed. */
const normalised = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");

/** The one selected expression aliased `AS <alias>`, extracted whole. */
function selected(sql: string, alias: string): string {
  const end = sql.indexOf(` AS ${alias}`);
  if (end < 0) throw new Error(`the guard's statement selects no ${alias}`);
  let close = end;
  while (close > 0 && sql[close] !== ")") close--;
  let depth = 0;
  let open = close;
  for (; open >= 0; open--) {
    if (sql[open] === ")") depth++;
    else if (sql[open] === "(" && --depth === 0) break;
  }
  if (open < 0) throw new Error(`unbalanced expression for ${alias}`);
  const head = sql.slice(0, open).match(/(?:NOT\s+)?EXISTS\s*$/);
  return sql.slice(head ? open - head[0].length : open, close + 1);
}

/** `(SELECT count(*) FROM x a WHERE p)`, run over the modelled table. */
function filledSections(sql: string): number {
  const expr = selected(normalised(sql), "filled_sections");
  const m = expr.match(/^\(\s*SELECT count\(\*\) FROM (\w+) (\w+) WHERE ([\s\S]+)\)$/);
  if (!m) throw new Error(`unsupported filled_sections expression: ${expr}`);
  const p = predicate(m[3]!, [m[2]!, "v"]);
  const v = visitRow();
  return rows(m[1]!).filter((r) => p(r, v)).length;
}

function hasVitals(sql: string): boolean {
  return predicate(selected(normalised(sql), "has_vitals"), ["v"])(visitRow());
}

/**
 * The required sections this visit has not satisfied — array_agg's own result,
 * so NULL (not an empty array) when nothing is missing, as Postgres returns.
 *
 * The evaluated slice starts at `AND t.is_required`: the WHERE's first term,
 * `t.template_id = COALESCE(v.note_template_id, …)`, resolves which template
 * the sections come from and is pinned separately, by the SQL-text assertions
 * in "falls back to the org's active template when the visit has no pin" and
 * by the parity test in documentation-gaps-load.spec.ts. Modelling it here
 * would need note_template rows this fake has no other use for. If that term
 * or the `AND t.is_required` anchor is ever removed, the slice throws and
 * every test below goes red rather than quietly evaluating something else.
 */
function missingRequired(sql: string): string[] | null {
  const expr = selected(normalised(sql), "missing_required");
  const from = expr.match(/FROM (\w+) (\w+) LEFT JOIN (\w+) (\w+) ON ([\s\S]+?) WHERE /);
  if (!from) throw new Error(`unsupported missing_required expression: ${expr}`);
  const [, candidateTable, tAlias, joinTable, sAlias, onSql] = from as unknown as string[];

  const on = predicate(onSql!, [sAlias!, tAlias!, "v"]);
  const start = expr.indexOf("AND t.is_required");
  if (start < 0) throw new Error("the guard no longer filters on t.is_required");
  const endAt = expr.lastIndexOf("END");
  const where = predicate(expr.slice(start + 4, endAt + 3), [tAlias!, sAlias!, "v"]);

  const v = visitRow();
  const hits = (rows(candidateTable!) as TemplateSection[]).filter((t) => {
    const s = rows(joinTable!).find((row) => on(row, t, v)) ?? NO_SECTION_ROW;
    return where(t, s, v);
  });

  // The order the clinician reads the names in, taken from array_agg's own
  // ORDER BY rather than assumed.
  const orderBy = expr.match(/array_agg\(\s*t\.label ORDER BY (\w+)\.(\w+)\s*\)/);
  const ordered = orderBy
    ? [...hits].sort(
        (a, b) =>
          Number((a as unknown as Record<string, number>)[orderBy[2]!]) -
          Number((b as unknown as Record<string, number>)[orderBy[2]!]),
      )
    : hits;
  return ordered.length > 0 ? ordered.map((t) => t.label) : null;
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM visit") && sql.includes("SELECT")) {
      const visitRows = currentStatus
        ? [{
            status: currentStatus, document_text: currentNote, dx_count: currentDx,
            clinician_user_id: currentClinician, signer_credential: currentCred,
            is_telehealth: currentTele, telehealth_consent_documented: currentConsent,
            coding_basis: currentBasis,
            // Only when the statement reads them, as Postgres answers.
            ...(sql.includes("v.total_minutes") ? { total_minutes: currentTotal } : {}),
            ...(sql.includes("v.acp_minutes") ? { acp_minutes: currentAcp } : {}),
            resolved_template_id: currentPin ?? ACTIVE_TEMPLATE,
            // Computed by the statement's own expressions over the modelled
            // tables above, never supplied.
            filled_sections: filledSections(sql),
            has_vitals: hasVitals(sql),
            missing_required: missingRequired(sql),
          }]
        : [];
      // Whatever another session writes after this read and before the UPDATE.
      if (raceAfterGuard) {
        currentPin = raceAfterGuard;
        raceAfterGuard = null;
      }
      return Promise.resolve(visitRows);
    }
    // A pin written by an UPDATE, answered the way its SQL reads: COALESCE
    // keeps a pin the visit has, a bare assignment overwrites it.
    const at = sql.indexOf("note_template_id = ");
    if (sql.includes("UPDATE visit SET") && at >= 0) {
      const given = values[sql.slice(0, at).split("¶").length - 1] as string | null;
      currentPin = sql.includes("note_template_id = COALESCE(note_template_id,")
        ? (currentPin ?? given)
        : given;
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const wroteUpdate = () => calls.some((c) => c.sql.includes("UPDATE visit SET"));

beforeEach(() => {
  calls = [];
  currentStatus = "in_progress";
  currentNote = null;
  currentDx = 1;
  currentClinician = USER;
  currentCred = "NP";
  currentTele = undefined;
  currentConsent = undefined;
  currentBasis = undefined;
  currentTotal = undefined;
  currentAcp = undefined;
  currentPin = null;
  raceAfterGuard = null;
  // An org whose template declares no sections: nothing is required, which is
  // the state every case written before the required-section guard assumed.
  template = [];
  noteSections = [];
  vitalsRows = [];
  currentVisitType = "established_patient_home";
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("transitionVisit → documented", () => {
  it("refuses to sign a visit whose note is empty, and writes nothing", async () => {
    currentNote = null;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).rejects.toThrow(/document|note/i);
    expect(wroteUpdate()).toBe(false);
  });

  it("refuses when the note is an untouched empty TipTap doc", async () => {
    currentNote = '{"type":"doc","content":[]}';
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).rejects.toThrow(/document|note/i);
    expect(wroteUpdate()).toBe(false);
  });

  it("CONTROL — signs a genuinely documented visit", async () => {
    currentNote =
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"HPI: seen at home."}]}]}';
    const r = await transitionVisit({
      orgId: ORG,
      id: VISIT,
      to: "documented",
      signedByUserId: USER,
    });
    expect(r).toEqual({ from: "in_progress", to: "documented" });
    expect(wroteUpdate()).toBe(true);
  });

  it("CONTROL — the note requirement does not block other transitions", async () => {
    // documented → pending_billing must still work; the note was already
    // checked at sign-off and re-checking here would strand signed visits.
    currentStatus = "documented";
    currentNote = null;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    expect(r).toEqual({ from: "documented", to: "pending_billing" });
    expect(wroteUpdate()).toBe(true);
  });

  it("CONTROL — cancelling an undocumented visit is still allowed", async () => {
    currentNote = null;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "cancelled" });
    expect(r).toEqual({ from: "in_progress", to: "cancelled" });
  });

  it("still rejects an illegal transition before looking at the note", async () => {
    currentStatus = "billed";
    currentNote = null;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).rejects.toThrow(/illegal status transition/i);
  });

  it("still 404s a missing visit", async () => {
    currentStatus = "";
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("the missing-required query", () => {
  /**
   * These assert the SQL's TEXT and nothing else: they say the statement
   * mentions a phrase, not that the statement decides anything. Read them as
   * a check that this query and sectionIsRequiredFor() still describe the same
   * rule — if the two drift, the note screen tells a clinician a section is
   * optional while the signature refuses it, or the reverse.
   *
   * They are NOT coverage of the predicate. A grep for a phrase can be
   * satisfied by a different part of the same statement: the vitals assertion
   * below matched `num_nonnulls(...)` in the has_vitals EXISTS whether or not
   * the required-section CASE still carried it. What the guard DOES is run
   * over rows in "the missing-required query, run over rows" further down.
   */
  const guardSql = async () => {
    currentNote = "Home visit note.";
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }).catch(() => {});
    return calls.find((c) => c.sql.includes("AS missing_required"))!.sql;
  };

  it("exempts sections listed against this visit's own type", async () => {
    expect(await guardSql()).toContain(
      "NOT (v.visit_type = ANY (t.not_required_for_visit_types))",
    );
  });

  it("judges a required vitals section by visit_vitals, not by its content row", async () => {
    // A vitals section's own content is always empty by construction, so the
    // plain is_empty test would report it missing on every visit and make
    // every home visit unsignable.
    const sql = await guardSql();
    expect(sql).toContain("WHEN t.kind = 'vitals' THEN NOT EXISTS");
    expect(sql).toContain("num_nonnulls(vv.height_cm, vv.weight_kg");
    // And it must no longer simply skip vitals, which is what made the
    // section decorative before it was required.
    expect(sql).not.toContain("AND t.kind <> 'vitals'");
  });

  it("still ignores sections the template does not require", async () => {
    expect(await guardSql()).toContain("AND t.is_required");
  });

  it("falls back to the org's active template when the visit has no pin", async () => {
    // A visit with nothing in its structured note has no pin yet
    // (note_template_id is set by the first section save, carry-forward,
    // recorded vitals, or sign-off). Joining on it directly meant such a
    // visit matched no template rows at all, so missing_required came back
    // NULL and the guard passed. Verified on localhost: a home visit missing
    // social history and physical exam signed straight through to
    // pending_billing.
    const sql = await guardSql();
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain("v.note_template_id");
    expect(sql).toMatch(/FROM note_template nt\s+WHERE nt\.org_id = v\.org_id AND nt\.is_active/);
  });
});

/**
 * The same query, decided rather than described.
 *
 * Every case here goes through transitionVisit, so what is asserted is the
 * refusal a clinician reads, built from the statement's own result over the
 * modelled tables at the top of this file.
 */
describe("the missing-required query, run over rows", () => {
  const section = (
    key: string,
    label: string,
    extra: Partial<TemplateSection> = {},
  ): TemplateSection => ({
    section_key: key,
    label,
    kind: "prose",
    is_required: true,
    not_required_for_visit_types: [],
    sort_order: 10,
    ...extra,
  });
  /** A visit_vitals row with all ten readings NULL — a cleared correction. */
  const noReadings = (visitId = VISIT) => ({
    visit_id: visitId,
    height_cm: null,
    weight_kg: null,
    bp_systolic: null,
    bp_diastolic: null,
    heart_rate: null,
    resp_rate: null,
    temperature_c: null,
    spo2_percent: null,
    pps_percent: null,
    pain_score: null,
  });

  const sign = () =>
    transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });

  beforeEach(() => {
    currentNote = "Home visit note.";
  });

  it("refuses when a required section was never written at all", async () => {
    template = [section("hpi", "History of present illness")];
    await expect(sign()).rejects.toThrow(
      "This note is missing a required section: History of present illness. Complete it before signing.",
    );
    expect(wroteUpdate()).toBe(false);
  });

  it("refuses when a required section was opened, left blank and saved", async () => {
    // A clinician who opens the section, types nothing and saves leaves an
    // is_empty row behind. The row exists, so a guard that only asked whether
    // the row exists would attest a note with that section blank.
    template = [section("hpi", "History of present illness")];
    noteSections = [{ id: "s1", visit_id: VISIT, section_key: "hpi", is_empty: true }];
    await expect(sign()).rejects.toThrow(
      "This note is missing a required section: History of present illness. Complete it before signing.",
    );
    expect(wroteUpdate()).toBe(false);
  });

  it("refuses when the required Vitals section has a row holding no readings", async () => {
    // A correction that cleared every reading leaves a visit_vitals row with
    // ten NULLs. The section is satisfied by readings, never by the presence
    // of the row.
    template = [section("vitals", "Vitals", { kind: "vitals" })];
    vitalsRows = [noReadings()];
    await expect(sign()).rejects.toThrow(
      "This note is missing a required section: Vitals. Complete it before signing.",
    );
    expect(wroteUpdate()).toBe(false);
  });

  it("CONTROL — signs once the section holds text and the vitals hold a reading", async () => {
    template = [section("hpi", "History of present illness"), section("vitals", "Vitals", { kind: "vitals" })];
    noteSections = [{ id: "s1", visit_id: VISIT, section_key: "hpi", is_empty: false }];
    vitalsRows = [{ ...noReadings(), bp_systolic: 118 }];
    await expect(sign()).resolves.toEqual({ from: "in_progress", to: "documented" });
    expect(wroteUpdate()).toBe(true);
  });

  it("does not let another visit's section row satisfy this visit", async () => {
    // The section join is scoped to this visit. Unscoped, any visit in the org
    // that filled the same section key would sign this one's note for it.
    template = [section("hpi", "History of present illness")];
    noteSections = [{ id: "s9", visit_id: OTHER_VISIT, section_key: "hpi", is_empty: false }];
    await expect(sign()).rejects.toThrow(/History of present illness/);
    expect(wroteUpdate()).toBe(false);
  });

  it("does not let another visit's vitals satisfy this visit's Vitals section", async () => {
    template = [section("vitals", "Vitals", { kind: "vitals" })];
    vitalsRows = [{ ...noReadings(OTHER_VISIT), bp_systolic: 118 }];
    await expect(sign()).rejects.toThrow(/Vitals/);
  });

  it("names every missing section, in the template's own order", async () => {
    // Declared out of order on purpose: the clinician reads them in the order
    // the template lays the note out, not the order the rows happen to arrive.
    template = [
      section("assessment_and_plan", "Assessment and plan", { sort_order: 30 }),
      section("hpi", "History of present illness", { sort_order: 10 }),
      section("physical_exam", "Physical examination", { sort_order: 20 }),
    ];
    await expect(sign()).rejects.toThrow(
      "This note is missing required sections: History of present illness, Physical examination, Assessment and plan. Complete them before signing.",
    );
  });

  it("CONTROL — an optional section, and one excepted for this visit type, are never demanded", async () => {
    template = [
      section("goals_of_care", "Goals of care", { is_required: false }),
      section("physical_exam", "Physical examination", {
        not_required_for_visit_types: ["established_patient_home"],
      }),
    ];
    await expect(sign()).resolves.toEqual({ from: "in_progress", to: "documented" });
  });

  it("excuses a video visit of any type from a section excepted for telehealth", async () => {
    // Same rule as sectionIsRequiredFor(..., isTelehealth): the exception
    // follows the visit's own flag, not only its type slug.
    template = [
      section("physical_exam", "Physical examination", {
        not_required_for_visit_types: ["telehealth"],
      }),
    ];
    currentTele = true;
    currentConsent = true;
    await expect(sign()).resolves.toEqual({ from: "in_progress", to: "documented" });
  });

  it("CONTROL — the same section is still demanded of the same visit in person", async () => {
    template = [
      section("physical_exam", "Physical examination", {
        not_required_for_visit_types: ["telehealth"],
      }),
    ];
    currentTele = false;
    await expect(sign()).rejects.toThrow(/Physical examination/);
  });

  it("checks required sections only at sign-off, never on later transitions", async () => {
    // Re-checking here would strand visits signed before the template grew a
    // section, in the billing queue with no way out.
    currentStatus = "documented";
    template = [section("hpi", "History of present illness")];
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" }),
    ).resolves.toEqual({ from: "documented", to: "pending_billing" });
  });

  /**
   * The guard's other arm, over the same rows.
   *
   * `filled_sections > 0 || has_vitals || !noteIsEmpty(document_text)` is what
   * stands between a blank note and a signature — the 20 Aug defect in this
   * file's header. The cases above all reach the refusal through
   * missing_required, so they still pass if filled_sections counts blank
   * section rows or has_vitals counts a row with no readings: the template
   * here declares NO required sections, which empties missing_required and
   * leaves this arm alone to decide.
   *
   * Each case also plants a row belonging to OTHER_VISIT that would satisfy
   * the arm if the subquery stopped scoping to this visit.
   */
  describe("what counts as documentation at all", () => {
    beforeEach(() => {
      // Nothing required, and no legacy free text: the only documentation on
      // offer is the rows each case plants.
      template = [];
      currentNote = null;
    });

    it("refuses a note whose sections were all opened, left blank and saved", async () => {
      // Opening each section and saving without typing leaves is_empty rows
      // behind. Counting them as documentation attests an empty note — and
      // the structured editor writes such a row for every section the
      // clinician merely clicks into.
      noteSections = [
        { id: "s1", visit_id: VISIT, section_key: "hpi", is_empty: true },
        { id: "s2", visit_id: VISIT, section_key: "physical_exam", is_empty: true },
        { id: "s9", visit_id: OTHER_VISIT, section_key: "hpi", is_empty: false },
      ];
      await expect(sign()).rejects.toThrow("This visit has no documentation");
      expect(wroteUpdate()).toBe(false);
    });

    it("CONTROL — one section with text in it is documentation", async () => {
      noteSections = [{ id: "s1", visit_id: VISIT, section_key: "hpi", is_empty: false }];
      await expect(sign()).resolves.toEqual({ from: "in_progress", to: "documented" });
      expect(wroteUpdate()).toBe(true);
    });

    it("refuses a note whose only vitals row holds ten NULL readings", async () => {
      // A correction that cleared every reading leaves the row behind. The
      // row's existence is not a measurement, and a visit whose whole record
      // is that row has nothing an auditor can read.
      vitalsRows = [noReadings(), { ...noReadings(OTHER_VISIT), bp_systolic: 118 }];
      await expect(sign()).rejects.toThrow("This visit has no documentation");
      expect(wroteUpdate()).toBe(false);
    });

    it("CONTROL — a single recorded reading is documentation, including a pain score of 0", async () => {
      // 0 is a reading a clinician took, not a missing one: num_nonnulls
      // counts it, and so must this.
      vitalsRows = [{ ...noReadings(), pain_score: 0 }];
      await expect(sign()).resolves.toEqual({ from: "in_progress", to: "documented" });
      expect(wroteUpdate()).toBe(true);
    });
  });
});

describe("transitionVisit → documented: diagnosis (audit R13)", () => {
  // The bill is built from the visit's diagnoses. The document screen used to
  // have no ICD-10 input, so every claim inherited the intake diagnosis or
  // carried none — and a claim with no diagnosis is rejected before review.
  it("refuses to sign a visit with no diagnosis, and writes nothing", async () => {
    currentNote = "Home visit note.";
    currentDx = 0;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).rejects.toThrow(/at least one diagnosis/i);
    expect(wroteUpdate()).toBe(false);
  });

  it("CONTROL — signs once a diagnosis is recorded on the visit", async () => {
    currentNote = "Home visit note.";
    currentDx = 1;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented" });
    expect(r).toEqual({ from: "in_progress", to: "documented" });
  });

  // The clinician reads this refusal seconds after the Diagnosis card, which
  // gives the clinical reason and mentions the claim only "on a billed visit".
  // A "Not billed" type drafts no bill — the card two below says so outright —
  // so a refusal blaming the bill contradicted what they had just read.
  it("gives the clinical reason on a Not billed visit, which drafts no bill", async () => {
    currentNote = "Home visit note.";
    currentDx = 0;
    currentBasis = "non_billable";
    const err = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err!.message).toMatch(/at least one diagnosis/i);
    expect(err!.message).toMatch(/say what it was for/i);
    expect(err!.message).not.toMatch(/bill/i);
    expect(wroteUpdate()).toBe(false);
  });

  it("CONTROL — a billed visit is still told the bill is built from them", async () => {
    currentNote = "Home visit note.";
    currentDx = 0;
    const err = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err!.message).toMatch(/bill is built from the diagnoses/i);
    expect(wroteUpdate()).toBe(false);
  });

  it("checks the diagnosis only at sign-off, never on later transitions", async () => {
    // Re-checking on documented → pending_billing would strand visits signed
    // before this rule existed.
    currentStatus = "documented";
    currentDx = 0;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    expect(r).toEqual({ from: "documented", to: "pending_billing" });
  });

  it("counts the visit's own codes, never the patient's intake diagnosis", async () => {
    currentNote = "Home visit note.";
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }).catch(() => {});
    const sql = calls.find((c) => c.sql.includes("AS missing_required"))!.sql;
    expect(sql).toContain("array_length(v.icd10_codes, 1)");
    expect(sql).not.toContain("primary_diagnosis_icd10");
  });
});

describe("transitionVisit → documented: the note keeps its template version", () => {
  const NOTE =
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Seen at home."}]}]}';

  it("pins an unpinned note at sign-off, in the signing UPDATE, to the version the guard judged it by", async () => {
    currentNote = NOTE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });

    expect(currentPin).toBe(ACTIVE_TEMPLATE);
    // The same statement that signs, so the pin commits or rolls back with it.
    const upd = calls.find((c) => c.sql.includes("note_template_id = "))!;
    expect(upd.sql).toContain("status = 'documented'");
  });

  it("CONTROL: a pin written while the signature is in flight survives it", async () => {
    // Why COALESCE rather than a plain assignment. The guard reads the
    // version a moment before the UPDATE writes it; in between, another
    // session can pin this note (a section saved as the clinician signs).
    // Assigning the version the guard read would move an attested note onto
    // a version its author never wrote under.
    currentNote = NOTE;
    currentPin = null;
    raceAfterGuard = V1_TEMPLATE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(currentPin).toBe(V1_TEMPLATE);
  });

  it("CONTROL: keeps a pin the note already has, and pins nothing on a later transition", async () => {
    currentNote = NOTE;
    currentPin = V1_TEMPLATE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(currentPin).toBe(V1_TEMPLATE);

    currentStatus = "documented";
    currentPin = null;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    expect(currentPin).toBeNull();
  });

  it("reads the version with the same COALESCE the required-section check uses, in the same statement", async () => {
    currentNote = NOTE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented" });
    const sql = calls
      .find((c) => c.sql.includes("AS missing_required"))!
      .sql.replace(/\s+/g, " ")
      .replace(/\( /g, "(");
    const resolution =
      "COALESCE(v.note_template_id, (SELECT nt.id FROM note_template nt WHERE nt.org_id = v.org_id AND nt.is_active LIMIT 1))";
    expect(sql).toContain(`${resolution} AS resolved_template_id`);
    expect(sql).toContain(`WHERE t.template_id = ${resolution}`);
  });
});

describe("transitionVisit → documented: who attested it (audit R32)", () => {
  const NOTE =
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Seen at home."}]}]}';
  const signUpdate = () => calls.find((c) => c.sql.includes("signer_credential = "));

  it("snapshots the signer's recorded credential into the visit", async () => {
    currentNote = NOTE;
    currentCred = "MD";
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(signUpdate()!.values).toContain("MD");
    expect(signUpdate()!.values).toContain(USER);
  });

  it("stores no credential when none is recorded — it does not guess", async () => {
    currentNote = NOTE;
    currentCred = null;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(signUpdate()!.values).toContain(null);
  });

  it("audits whether the signer is the clinician of record, by id — and still signs", async () => {
    currentNote = NOTE;
    currentClinician = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(r.to).toBe("documented");
    const entry = vi.mocked(writeAudit).mock.calls.at(-1)![1];
    expect(entry.payload).toMatchObject({ credential: "NP", signerIsClinicianOfRecord: false });
  });

  it("marks the clinician of record signing their own note", async () => {
    currentNote = NOTE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(vi.mocked(writeAudit).mock.calls.at(-1)![1].payload).toMatchObject({
      signerIsClinicianOfRecord: true,
    });
  });

  it("never writes a credential on documented → pending_billing", async () => {
    currentStatus = "documented";
    await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    expect(signUpdate()).toBeUndefined();
  });
});

describe("transitionVisit → documented: telehealth (audit R22)", () => {
  // Consent was enforced only by the document screen, so any API client could
  // sign a telehealth visit with none on record.
  const NOTE = "Seen over video, comfortable.";

  it("refuses to sign a telehealth visit with no consent documented, and writes nothing", async () => {
    currentNote = NOTE;
    currentTele = true;
    currentConsent = false;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).rejects.toThrow(/consent documented before signing/i);
    expect(wroteUpdate()).toBe(false);
  });

  it("treats a NULL consent column as not documented", async () => {
    currentNote = NOTE;
    currentTele = true;
    currentConsent = null;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).rejects.toThrow(/consent/i);
  });

  it("CONTROL — signs once consent is documented", async () => {
    currentNote = NOTE;
    currentTele = true;
    currentConsent = true;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(r).toEqual({ from: "in_progress", to: "documented" });
    expect(wroteUpdate()).toBe(true);
  });

  it("CONTROL — an in-person visit needs no telehealth consent", async () => {
    currentNote = NOTE;
    currentTele = false;
    currentConsent = false;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(r.to).toBe("documented");
  });

  it("checks consent only at sign-off, never on later transitions", async () => {
    currentStatus = "documented";
    currentTele = true;
    currentConsent = false;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    expect(r).toEqual({ from: "documented", to: "pending_billing" });
  });

  it("reads the flag and the consent from the visit row itself", async () => {
    currentNote = NOTE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }).catch(() => {});
    const sql = calls.find((c) => c.sql.includes("AS missing_required"))!.sql;
    expect(sql).toContain("v.is_telehealth");
    expect(sql).toContain("v.telehealth_consent_documented");
  });

  it("exempts a video visit of any type from sections excepted for telehealth", async () => {
    // Same rule as sectionIsRequiredFor(section, type, isTelehealth): the
    // "telehealth" exception follows the visit's flag, not only its slug.
    currentNote = NOTE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }).catch(() => {});
    const sql = calls.find((c) => c.sql.includes("AS missing_required"))!.sql;
    expect(sql).toMatch(
      /AND NOT \(COALESCE\(v\.is_telehealth, false\)\s+AND 'telehealth' = ANY \(t\.not_required_for_visit_types\)\)/,
    );
    // The per-type exemption is untouched alongside it.
    expect(sql).toContain("NOT (v.visit_type = ANY (t.not_required_for_visit_types))");
  });
});

/**
 * ACP time is spent during the visit, so it cannot be more than the visit's
 * total. Only the document screen's suggestion could know, and it did not:
 * on localhost a 30-minute visit with 40 ACP minutes was suggested 99497, and
 * nothing here would have refused to sign it.
 */
describe("transitionVisit → documented: ACP minutes within the visit", () => {
  const NOTE = "Goals-of-care conversation with the patient and daughter.";

  it("refuses to sign more ACP minutes than the visit's total, and writes nothing", async () => {
    currentNote = NOTE;
    currentTotal = 30;
    currentAcp = 40;
    const err = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err!.message).toBe(
      "40 minutes of ACP is more than the visit's 30 minutes in total. ACP time is part of the visit: correct the start and stop times, or the ACP minutes.",
    );
    expect(wroteUpdate()).toBe(false);
  });

  it("refuses ACP minutes on a visit with no total time recorded", async () => {
    currentNote = NOTE;
    currentTotal = null;
    currentAcp = 20;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).rejects.toThrow(/20 minutes of ACP is more than the visit's 0 minutes/);
    expect(wroteUpdate()).toBe(false);
  });

  it("CONTROL — signs ACP minutes that fill the whole visit", async () => {
    currentNote = NOTE;
    currentTotal = 30;
    currentAcp = 30;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).resolves.toEqual({ from: "in_progress", to: "documented" });
    expect(wroteUpdate()).toBe(true);
  });

  it("CONTROL — signs a visit with no ACP minutes and no total", async () => {
    currentNote = NOTE;
    currentTotal = null;
    currentAcp = 0;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER }),
    ).resolves.toEqual({ from: "in_progress", to: "documented" });
  });

  it("checks only at sign-off, so a visit signed before this rule still moves to billing", async () => {
    currentStatus = "documented";
    currentTotal = 30;
    currentAcp = 40;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" }),
    ).resolves.toEqual({ from: "documented", to: "pending_billing" });
  });

  it("reads both minutes from the visit row, in the guard's own statement", async () => {
    currentNote = NOTE;
    await transitionVisit({ orgId: ORG, id: VISIT, to: "documented" });
    const sql = calls.find((c) => c.sql.includes("AS missing_required"))!.sql;
    expect(sql).toContain("v.total_minutes");
    expect(sql).toContain("v.acp_minutes");
  });
});

describe("transitionVisit: a Not billed visit type (audit R18)", () => {
  // Signed is where such a visit rests. Moving it to pending_billing would put
  // it in the billing queue, and the transition route drafts a bill on exactly
  // that edge, so the refusal has to live in the service.
  const NOTE = "Visited the family after the death. Grief support offered.";

  it("refuses documented → pending_billing, and writes and audits nothing", async () => {
    vi.mocked(writeAudit).mockClear();
    currentStatus = "documented";
    currentBasis = "non_billable";
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing", signedByUserId: USER }),
    ).rejects.toThrow(/not billed/i);
    expect(wroteUpdate()).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("refuses with a ValidationError, which the route answers with 422", async () => {
    currentStatus = "documented";
    currentBasis = "non_billable";
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("CONTROL — an established visit still moves to billing", async () => {
    currentStatus = "documented";
    currentBasis = "established_patient_home";
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    expect(r).toEqual({ from: "documented", to: "pending_billing" });
    expect(wroteUpdate()).toBe(true);
  });

  it("CONTROL — a visit whose slug has no type row (pre-0062) still moves to billing", async () => {
    currentStatus = "documented";
    currentBasis = null;
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    expect(r.to).toBe("pending_billing");
  });

  it("CONTROL — a Not billed visit can still be signed", async () => {
    currentNote = NOTE;
    currentBasis = "non_billable";
    const r = await transitionVisit({ orgId: ORG, id: VISIT, to: "documented", signedByUserId: USER });
    expect(r).toEqual({ from: "in_progress", to: "documented" });
    expect(wroteUpdate()).toBe(true);
  });

  it("still reports an illegal move as illegal first", async () => {
    currentStatus = "in_progress";
    currentBasis = "non_billable";
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" }),
    ).rejects.toThrow(/illegal status transition/i);
  });

  it("reads the band from the org's own visit type, in the same query", async () => {
    currentStatus = "documented";
    await transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" });
    const sql = calls.find((c) => c.sql.includes("AS missing_required"))!.sql;
    expect(sql).toMatch(
      /SELECT ot\.coding_basis FROM org_visit_type ot\s+WHERE ot\.org_id = v\.org_id AND ot\.slug = v\.visit_type/,
    );
  });
});
