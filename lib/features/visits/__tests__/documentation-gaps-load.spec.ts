/**
 * The payer-documentation loader (audit R19) — which template version it
 * judges a note by.
 *
 * documentation-check.spec.ts next door tests the pure comparison with canned
 * facts. It never runs loadDocumentationGaps, so the SQL that gathers those
 * facts was never constructed by a test at all, and the COALESCE that resolves
 * the visit's note template — its own pinned version, else the org's active
 * one — could be deleted from both queries without a single test noticing.
 *
 * It decides whether a payer's required element is MISSING (which blocks the
 * claim at submit) or UNVERIFIABLE (which does not). Judge a v1 note by v2 and
 * a section v2 dropped stops being a gap: the claim goes out with the payer's
 * requirement undocumented and nothing said.
 *
 * The fake database answers by template id rather than with canned rows, and
 * works out which id the query asked for by reading the query's own template
 * resolution: a pin reference alone resolves to the pin, an is_active
 * reference alone to the active version, both (the COALESCE) to the pin then
 * the active version, as Postgres would.
 *
 * The documentation_requirement lookup is answered the same way: the fake
 * holds ROWS and runs the query's own WHERE over them, binds included. It
 * used to answer `sql.includes("FROM documentation_requirement")` with one
 * canned row whatever the predicates said, which is why all four of the
 * effective-date window's mutations — dropping either date predicate, moving
 * the expiry boundary from > to >=, and shifting the effective date by a day
 * — left the whole suite green. Both dates bind the same date of service, so
 * an assertion on the query's VALUES cannot see any of them either.
 *
 * The facts row is answered the same way: the date of service is whatever the
 * statement's own SELECT item gives for the modelled visit and bill (a
 * session-zone ::date cast, the bill's DATE, or the visit's instant and the
 * org's zone), and a column comes back only if the statement selects it.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { documentationGap } from "../documentation-check";
import { loadDocumentationGaps } from "../documentation-check.service";

const VISIT = "e0000000-0000-4000-8000-00000000000c";
const SUPERBILL = "b2e303af-e2cb-4292-8d00-c35c07423a0d";
const PAYER = "a0000000-0000-4000-8000-000000000302";

const ORG = "11111111-1111-4111-8111-111111111111";
/** A second tenant, whose active template the fallback must never reach. */
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

const V1 = "71000000-0000-4000-8000-000000000001";
const V2 = "72000000-0000-4000-8000-000000000002";
const V_OTHER = "73000000-0000-4000-8000-000000000003";
/** v2 is what an admin saves after dropping the chief complaint section. */
const TEMPLATES: Record<string, string[]> = {
  [V1]: ["chief_complaint", "hpi", "physical_exam", "assessment_and_plan"],
  [V2]: ["hpi", "physical_exam", "assessment_and_plan", "spiritual_assessment"],
  // The other tenant still asks for a chief complaint, so reading this visit
  // through it turns an UNVERIFIABLE element into a MISSING one.
  [V_OTHER]: ["chief_complaint", "hpi", "physical_exam", "assessment_and_plan"],
};

/** A payer this visit is not billed under, for the payer predicate. */
const OTHER_PAYER = "a0000000-0000-4000-8000-000000000399";
/** The visit's date of service: the day it happened, where it happened. */
const DOS = "2026-09-09";
/** 11 am EDT on 9 Sep: the same day in every zone this spec meets. */
const DAYTIME = new Date("2026-09-09T15:00:00Z");
/** 8:30 pm EDT on 9 Sep, which is already the 10th in UTC and in Karachi. */
const EVENING = new Date("2026-09-10T00:30:00Z");
/** A DATE column as Prisma returns it: the day at UTC midnight. */
const dateColumn = (iso: string) => new Date(`${iso}T00:00:00Z`);

interface RequirementRow {
  code: string;
  /** NULL means "every payer" — the query's `OR payer_id IS NULL` arm. */
  payer_id: string | null;
  state: string | null;
  effective_date: string;
  /** NULL means open-ended. The window is half-open: expiry day excluded. */
  expiration_date: string | null;
  required_chart_elements: string[];
}

/**
 * The documentation_requirement table as this visit meets it. Only the first
 * two rows are in force for this payer, this state and this date of service;
 * every other row is a decoy that one specific predicate excludes, named after
 * the predicate that must exclude it. Nothing here decides which rows come
 * back — the query's own WHERE does, in requirementRows() below.
 *
 * UnitedHealthcare Community Plan Ohio's standard for a home visit is the
 * first row; the second is the all-payer, all-state row that exercises the two
 * `IS NULL` arms.
 */
const REQUIREMENTS: RequirementRow[] = [
  {
    code: "99349",
    payer_id: PAYER,
    state: "OH",
    effective_date: "2026-01-01",
    expiration_date: null,
    required_chart_elements: ["vitals", "chief_complaint", "physical_exam", "diagnosis", "plan"],
  },
  {
    code: "99349",
    payer_id: null,
    state: null,
    effective_date: "2026-01-01",
    expiration_date: null,
    required_chart_elements: ["time"],
  },
  // Takes effect the day AFTER this visit. Enforcing it would tell the
  // clinician the note lacks something the payer does not require yet.
  {
    code: "99349",
    payer_id: PAYER,
    state: "OH",
    effective_date: "2026-09-10",
    expiration_date: null,
    required_chart_elements: ["not_in_force_until_tomorrow"],
  },
  // Retired the day before this visit.
  {
    code: "99349",
    payer_id: PAYER,
    state: "OH",
    effective_date: "2025-01-01",
    expiration_date: "2026-09-08",
    required_chart_elements: ["retired_before_this_visit"],
  },
  // Its last day IS the date of service, and the window is half-open
  // (`expiration_date > dos`), so it no longer applies. This is the row the
  // `>` to `>=` mutation lets back in, and the one a count of returned rows
  // alone would never notice.
  {
    code: "99349",
    payer_id: PAYER,
    state: "OH",
    effective_date: "2025-01-01",
    expiration_date: DOS,
    required_chart_elements: ["expired_on_the_dos"],
  },
  {
    code: "99349",
    payer_id: OTHER_PAYER,
    state: "OH",
    effective_date: "2026-01-01",
    expiration_date: null,
    required_chart_elements: ["another_payers_standard"],
  },
  {
    code: "99349",
    payer_id: null,
    state: "CA",
    effective_date: "2026-01-01",
    expiration_date: null,
    required_chart_elements: ["another_states_standard"],
  },
  {
    code: "99350",
    payer_id: PAYER,
    state: "OH",
    effective_date: "2026-01-01",
    expiration_date: null,
    required_chart_elements: ["a_code_this_visit_is_not_billing"],
  },
];

/** Every element only a decoy row carries, so none may reach a finding. */
const DECOY_ELEMENTS = REQUIREMENTS.slice(2).flatMap((r) => r.required_chart_elements);

// ---------------------------------------------------------------------------
// Running the requirement query's own WHERE, rather than restating it.
// ---------------------------------------------------------------------------

/**
 * Compile a SQL boolean expression into a predicate over one row.
 *
 * The rule stays in the statement: this only translates SQL's spelling into
 * JavaScript's, so a predicate that is deleted, widened or moved by a day is
 * deleted, widened or moved by a day here too. It deliberately understands a
 * small grammar and THROWS on anything else — a query this cannot evaluate
 * must fail the test, never be answered with canned rows, which is the whole
 * defect being closed.
 *
 * ISO dates compare correctly as strings, which is why `::date` casts can be
 * dropped; `(date + n)` is the one bit of arithmetic, kept honest by dateAdd.
 */
function sqlPredicate(where: string, binds: readonly unknown[]) {
  let js = where.replace(/\s+/g, " ").trim();
  js = js.replace(/\(\s*(\$\d+)::date\s*\+\s*(\d+)\s*\)/g, "dateAdd($1, $2)");
  js = js.replace(/::[a-z_]+(\[\])?/gi, "");
  js = js.replace(/('[^']*'|[\w.$]+) = ANY\s*\(\s*([\w.$]+)\s*\)/g, "anyOf($2, $1)");
  js = js.replace(/([\w.$]+) IS NOT NULL/g, "($1 != null)");
  js = js.replace(/([\w.$]+) IS NULL/g, "($1 == null)");
  js = js.replace(/\bAND\b/g, "&&").replace(/\bOR\b/g, "||").replace(/\bNOT\s*\(/g, "!(");
  js = js.replace(/([^<>!=])=([^=])/g, "$1===$2");
  const keep = new Set(["null", "true", "false"]);
  js = js.replace(/(?<![$\w.])([a-z_][a-z0-9_]*)(?![\w(])/g, (m) => (keep.has(m) ? m : `row.${m}`));

  const untranslated = js.match(
    /\b(SELECT|FROM|WHERE|ANY|CASE|WHEN|THEN|ELSE|END|EXISTS|LIMIT|IS|AND|OR|NOT|NULL|TRUE|FALSE|BETWEEN|IN|LIKE)\b/,
  );
  if (untranslated) {
    throw new Error(
      `the requirement query uses SQL this test cannot evaluate (${untranslated[0]}): ${js}`,
    );
  }

  const params = binds.map((_, i) => `$${i}`);
  const fn = new Function(
    "row",
    "anyOf",
    "dateAdd",
    "cardinality",
    ...params,
    `return Boolean(${js});`,
  ) as (...a: unknown[]) => boolean;

  const anyOf = (haystack: unknown, needle: unknown) =>
    Array.isArray(haystack) && haystack.includes(needle);
  const dateAdd = (iso: unknown, days: unknown) => {
    const d = new Date(`${String(iso)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(days));
    return d.toISOString().slice(0, 10);
  };
  const cardinality = (a: unknown) => (Array.isArray(a) ? a.length : 0);

  return (row: RequirementRow) => fn(row, anyOf, dateAdd, cardinality, ...binds);
}

/**
 * The rows the requirement query really selects, given its own text and binds.
 * `strings` carries the statement with a hole at each bind, so the binds land
 * at the position the query puts them — swap two and the predicates change.
 */
function requirementRows(strings: TemplateStringsArray, values: unknown[]) {
  let bound = strings[0]!;
  for (let i = 1; i < strings.length; i++) bound += `$${i - 1}${strings[i]!}`;
  const at = bound.indexOf("WHERE");
  if (at < 0) throw new Error("the requirement query has no WHERE clause");
  const matches = sqlPredicate(bound.slice(at + "WHERE".length), values);
  return db.requirements.filter(matches);
}

let db: {
  /**
   * visit.note_template_id — NULL on a visit whose org had no active template
   * when its note was written or signed.
   */
  pin: string | null;
  /**
   * The note_template rows carrying is_active, in the order an unordered
   * LIMIT 1 meets them. Another tenant's sits first, because that is what a
   * fallback which forgets nt.org_id = dv.org_id would take.
   */
  actives: { orgId: string; templateId: string }[];
  /** documentation_requirement, as rows the query filters for itself. */
  requirements: RequirementRow[];
  /** COALESCE(visit.start_time, visit.scheduled_start); NULL = no time recorded. */
  visitAt: Date | null;
  /**
   * The visit's latest bill, which is SUPERBILL; null = not billed yet. Its
   * date_of_service is a DATE.
   */
  bill: { date_of_service: Date } | null;
  /** org.timezone of the visit's org. */
  orgTimezone: string;
  /** The database session's TimeZone: UTC in CI, Asia/Karachi on this machine. */
  sessionZone: string;
};
let calls: { sql: string; values: unknown[] }[] = [];

/** The template_keys subquery, which is where the resolution lives. */
const TEMPLATE_KEYS = /ARRAY\(SELECT ts\.section_key[\s\S]*?\) AS template_keys/;

function resolvedTemplate(sql: string): string | null {
  const expr = sql.match(TEMPLATE_KEYS)?.[0];
  if (!expr) throw new Error("the facts query selected no template_keys");

  // Each operand at the position the SQL writes it, first non-NULL wins — the
  // ORDER is read off the text, never assumed. Swap the COALESCE operands and
  // this resolves the org's current version over the version the note was
  // written under, which is the whole failure the fallback has to survive.
  return [
    { at: expr.indexOf("dv.note_template_id"), id: db.pin },
    { at: expr.indexOf("nt.is_active"), id: activeTemplate(expr) },
  ]
    .filter((o) => o.at >= 0)
    .sort((a, b) => a.at - b.at)
    .find((o) => o.id)?.id ?? null;
}

/**
 * Which active template the fallback subquery finds. Scoped to the visit's own
 * org it is this visit's org's; unscoped it is whichever row the table hands
 * back first, which in a multi-tenant table is another org's — this claim
 * judged against a payer standard read off a stranger's note template.
 */
function activeTemplate(expr: string): string | null {
  const rows = /nt\.org_id\s*=\s*dv\.org_id/.test(expr)
    ? db.actives.filter((a) => a.orgId === ORG)
    : db.actives;
  return rows[0]?.templateId ?? null;
}

/** The calendar day of an instant in a zone, as Postgres computes it. */
function pgDay(at: Date, zone: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const part = (t: string) => p.find((x) => x.type === t)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The dos the statement's own SELECT item gives, as Postgres returns it (a
 * DATE comes back as a Date at UTC midnight):
 *
 *   - `sb.date_of_service AS dos` — the claim's DATE;
 *   - `lb.date_of_service AS dos` — the visit's latest bill's DATE, or NULL
 *     before it is billed, and only if the lateral selects it;
 *   - `COALESCE(dv.start_time, dv.scheduled_start)::date AS dos` — the
 *     instant's day in the database SESSION's zone.
 */
function selectedDos(sql: string): Date | null {
  if (/\bsb\.date_of_service AS dos\b/.test(sql)) return db.bill?.date_of_service ?? null;
  if (/\blb\.date_of_service AS dos\b/.test(sql)) {
    const lateral = sql.match(/LEFT JOIN LATERAL \(([\s\S]*?)\) lb ON TRUE/)?.[1] ?? "";
    if (!/^\s*SELECT [^;]*\bs\.date_of_service\b[\s\S]*FROM superbill s\b/.test(lateral)) {
      throw new Error("column lb.date_of_service does not exist: the lateral does not select it");
    }
    return db.bill?.date_of_service ?? null;
  }
  if (/COALESCE\(dv\.start_time, dv\.scheduled_start\)::date AS dos\b/.test(sql)) {
    return db.visitAt ? dateColumn(pgDay(db.visitAt, db.sessionZone)) : null;
  }
  throw new Error("the facts query selected no dos this fake can evaluate");
}

function facts(sql: string) {
  const row: Record<string, unknown> = {
    is_telehealth: false,
    telehealth_modality: null,
    total_minutes: 45,
    dx_count: 1,
    dos: selectedDos(sql),
    state: "OH",
    payer_id: PAYER,
    payer_name: "UnitedHealthcare Community Plan Ohio",
    codes: ["99349"],
    // The note as written: no chief complaint anywhere in it.
    filled_keys: ["hpi", "physical_exam", "assessment_and_plan"],
    template_keys: TEMPLATES[resolvedTemplate(sql) ?? ""] ?? [],
    has_vitals: true,
    document_text: null,
  };
  // The visit's instant and its org's zone come back only when selected, the
  // zone only from an org joined on the visit's own org.
  if (/COALESCE\(dv\.start_time, dv\.scheduled_start\) AS visit_at\b/.test(sql)) row.visit_at = db.visitAt;
  if (/\bo\.timezone AS org_timezone\b/.test(sql) && /\bJOIN org o ON o\.id = dv\.org_id\b/.test(sql)) {
    row.org_timezone = db.orgTimezone;
  }
  return row;
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM documentation_requirement")) {
      return Promise.resolve(requirementRows(strings, values));
    }
    // The claim branch is matched first: it also joins visit dv.
    if (sql.includes("FROM superbill sb")) {
      return Promise.resolve(values.includes(SUPERBILL) && db.bill ? [facts(sql)] : []);
    }
    if (sql.includes("FROM visit dv")) {
      return Promise.resolve(values.includes(VISIT) ? [facts(sql)] : []);
    }
    return Promise.resolve([]);
  };
  return run;
}

/** The transaction client the loader runs on — the caller's, in production. */
type Tx = Parameters<typeof loadDocumentationGaps>[0];

const load = (
  target: { visitId: string } | { superbillId: string },
  opts?: Parameters<typeof loadDocumentationGaps>[2],
) => loadDocumentationGaps({ $queryRaw: fakeTx() } as unknown as Tx, target, opts);

beforeEach(() => {
  calls = [];
  db = {
    pin: V1,
    actives: [
      { orgId: OTHER_ORG, templateId: V_OTHER },
      { orgId: ORG, templateId: V2 },
    ],
    requirements: REQUIREMENTS.map((r) => ({ ...r })),
    // A daytime visit, billed on its own day as SUPERBILL.
    visitAt: DAYTIME,
    bill: { date_of_service: dateColumn(DOS) },
    orgTimezone: "America/New_York",
    sessionZone: "UTC",
  };
});

describe("loadDocumentationGaps judges a note by the version it was written under", () => {
  it("reports the chief complaint v1 asks for as missing, which blocks the claim", async () => {
    const g = await load({ visitId: VISIT });

    expect(g.payerName).toBe("UnitedHealthcare Community Plan Ohio");
    expect(g.results.map((r) => r.code)).toEqual(["99349"]);
    expect(g.results[0]!.missing.map((m) => m.element)).toEqual(["chief_complaint"]);
    expect(g.results[0]!.unverifiable).toEqual([]);
    // What that costs if the version is wrong: the submit gate. Put the org's
    // current version first in the COALESCE and this claim stops being
    // blocked, because v2 no longer asks for the element the note omits.
    expect(documentationGap(g.results, g.payerName)).not.toBeNull();
  });

  it("CONTROL — the same visit unpinned is judged by the org's active version", async () => {
    // A note written or signed while its org had no active template has no
    // pin, and the active version no longer carries a chief complaint section:
    // Pallio cannot see whether the note documents one, so it neither passes
    // nor blocks.
    db.pin = null;
    const g = await load({ visitId: VISIT });

    expect(g.results[0]!.missing).toEqual([]);
    expect(g.results[0]!.unverifiable.map((u) => u.element)).toEqual(["chief_complaint"]);
    expect(documentationGap(g.results, g.payerName)).toBeNull();
  });

  it("reads the claim about to go out the same way", async () => {
    // The submit path loads by superbill id, through a second copy of the
    // same SQL. It is the copy that decides whether a claim is refused.
    const g = await load({ superbillId: SUPERBILL });
    expect(g.results[0]!.missing.map((m) => m.element)).toEqual(["chief_complaint"]);

    // CONTROL: unpinned, that claim's note follows the active version too.
    db.pin = null;
    const u = await load({ superbillId: SUPERBILL });
    expect(u.results[0]!.missing).toEqual([]);
    expect(u.results[0]!.unverifiable.map((x) => x.element)).toEqual(["chief_complaint"]);
  });

  it("falls back only to the visit's OWN org's active template", async () => {
    // The fallback is a subquery over the whole note_template table, so it is
    // the half that can cross a tenant line. Unpinned is where it is reached —
    // and unscoped, LIMIT 1 takes whichever active row comes first: this
    // visit's note judged against a stranger's sections, which here turns an
    // element Pallio cannot see into one it blocks the claim over.
    db.pin = null;
    const v = await load({ visitId: VISIT });
    const s = await load({ superbillId: SUPERBILL });
    for (const g of [v, s]) {
      expect(g.results[0]!.missing).toEqual([]);
      expect(g.results[0]!.unverifiable.map((u) => u.element)).toEqual(["chief_complaint"]);
    }

    const exprs = calls
      .map((c) => c.sql.match(TEMPLATE_KEYS)?.[0])
      .filter((e): e is string => Boolean(e));
    expect(exprs).toHaveLength(2);
    // Scoped to dv.org_id, never to any org holding an active template.
    for (const e of exprs) expect(e).toContain("nt.org_id = dv.org_id");
  });
});

describe("which payer requirements are in force on the date of service", () => {
  /** Every element the loader ended up checking, across all codes. */
  const checked = (g: Awaited<ReturnType<typeof load>>) =>
    g.results.flatMap((r) => r.required.map((e) => e.element));

  it("checks the note against the requirements in force that day, and no others", async () => {
    const g = await load({ visitId: VISIT });

    // The payer's current standard plus the all-payer row. Nothing that
    // starts tomorrow, expired yesterday, expires today, belongs to another
    // payer or state, or is attached to a code this visit is not billing.
    expect(checked(g)).toEqual([
      "vitals",
      "chief_complaint",
      "physical_exam",
      "diagnosis",
      "plan",
      "time",
    ]);
    expect(g.results[0]!.missing.map((m) => m.element)).toEqual(["chief_complaint"]);
    // A decoy that slipped through would land here: the loader cannot read an
    // element it does not know, so it reports it unverifiable to a biller.
    expect(g.results[0]!.unverifiable).toEqual([]);
  });

  it("names each window a requirement can fall outside of", async () => {
    // One assertion per decoy, so a failure says which predicate went. The
    // date ones are the point: both bind the same date of service, so
    // deleting either leaves the query's VALUES unchanged.
    const elements = checked(await load({ visitId: VISIT }));
    for (const decoy of DECOY_ELEMENTS) {
      expect(elements, `${decoy} must not be applied to this visit`).not.toContain(decoy);
    }
  });

  it("applies a requirement on its first day and on its last full day", async () => {
    // CONTROL for the two tests above: the window must not be so narrow that
    // it excludes requirements that ARE in force. A rule effective exactly on
    // the date of service applies; one expiring the day after still applies.
    db.requirements = [
      { ...REQUIREMENTS[0]!, effective_date: DOS, expiration_date: "2026-09-10" },
    ];
    const g = await load({ visitId: VISIT });
    expect(checked(g)).toEqual([
      "vitals",
      "chief_complaint",
      "physical_exam",
      "diagnosis",
      "plan",
    ]);
    expect(g.results[0]!.missing.map((m) => m.element)).toEqual(["chief_complaint"]);
  });

  it("skips a requirement that names no chart elements at all", async () => {
    // A row with an empty element list has nothing to check. Returning it
    // would put a payer-documentation result on the reconciliation that
    // asserts nothing, under a payer standard that states nothing.
    db.requirements = [{ ...REQUIREMENTS[0]!, required_chart_elements: [] }];
    const g = await load({ visitId: VISIT });
    expect(g.results).toEqual([]);
    expect(documentationGap(g.results, g.payerName)).toBeNull();
  });

  it("reads the claim about to go out through the same window", async () => {
    // The submit gate loads by superbill id through a second copy of the
    // query. Both copies have to exclude the same rows.
    const g = await load({ superbillId: SUPERBILL });
    const elements = checked(g);
    for (const decoy of DECOY_ELEMENTS) {
      expect(elements, `${decoy} must not be applied to this claim`).not.toContain(decoy);
    }
    expect(g.results[0]!.missing.map((m) => m.element)).toEqual(["chief_complaint"]);
  });
});

/**
 * Which day a visit is checked on. The visit branch used to cast the visit's
 * instant with ::date, which is its day in the database session's zone: UTC in
 * CI, Asia/Karachi on this machine, and never the practice's. A visit from
 * 3 pm Eastern on was checked against the next day's payer standard locally,
 * and one from 8 pm Eastern on in CI too.
 */
describe("the date of service a visit is checked on", () => {
  const checked = (g: Awaited<ReturnType<typeof load>>) =>
    g.results.flatMap((r) => r.required.map((e) => e.element));
  const IN_FORCE_ON_THE_9TH = ["vitals", "chief_complaint", "physical_exam", "diagnosis", "plan", "time"];
  const requirementRead = () => calls.find((c) => c.sql.includes("FROM documentation_requirement"));

  for (const sessionZone of ["UTC", "Asia/Karachi"]) {
    it(`CONTROL: an unbilled visit at 8:30 pm EDT on the 9th is checked on the 9th (session ${sessionZone})`, async () => {
      db.sessionZone = sessionZone;
      db.bill = null;
      db.visitAt = EVENING;
      const elements = checked(await load({ visitId: VISIT }));
      expect(elements, "not_in_force_until_tomorrow must not be applied to this visit").not.toContain(
        "not_in_force_until_tomorrow",
      );
      expect(elements).toEqual(IN_FORCE_ON_THE_9TH);
      expect(requirementRead()!.values).toContain(DOS);
    });
  }

  it("CONTROL: the practice's own zone decides, not an assumed Eastern", async () => {
    // 10:30 pm PDT on 9 Sep: already the 10th in New York, UTC and Karachi.
    db.orgTimezone = "America/Los_Angeles";
    db.bill = null;
    db.visitAt = new Date("2026-09-10T05:30:00Z");
    expect(checked(await load({ visitId: VISIT }))).toEqual(IN_FORCE_ON_THE_9TH);
  });

  it("a billed visit is checked on its bill's date of service, as the claim about to go out is", async () => {
    // A bill saved before this fix, dated the evening visit's UTC day. The
    // payer holds that date, so the note is judged on it, the same way the
    // submit gate's claim read judges it. Passes before and after the fix; it
    // fails a fix that reads the visit's own day over the bill's.
    db.visitAt = EVENING;
    db.bill = { date_of_service: dateColumn("2026-09-10") };
    const visit = checked(await load({ visitId: VISIT }));
    expect(visit).toContain("not_in_force_until_tomorrow");
    expect(visit).toEqual(checked(await load({ superbillId: SUPERBILL })));
  });

  it("CONTROL: before the bill exists, the date of service being scored wins over the visit's", async () => {
    // The risk preview scores a draft on the day it will be billed on.
    db.bill = null;
    db.visitAt = DAYTIME;
    const elements = checked(await load({ visitId: VISIT }, { dos: "2026-09-10" }));
    expect(elements).toContain("not_in_force_until_tomorrow");
    expect(requirementRead()!.values).toContain("2026-09-10");
  });

  it("a saved bill's date wins over the one being scored", async () => {
    // Passes before and after the fix.
    const elements = checked(await load({ visitId: VISIT }, { dos: "2026-09-10" }));
    expect(elements).toEqual(IN_FORCE_ON_THE_9TH);
  });

  it("with no bill, no date given and no time recorded, checks nothing", async () => {
    // Passes before and after the fix.
    db.bill = null;
    db.visitAt = null;
    const g = await load({ visitId: VISIT });
    expect(g.results).toEqual([]);
    expect(requirementRead()).toBeUndefined();
  });
});

describe("the resolution is the sign guard's", () => {
  it("uses the same COALESCE, alias aside, in both queries as the sign guard", async () => {
    // Sign-off decides which sections a note owes by this expression, and
    // pins the version it resolves. A reader that resolves it differently
    // reports gaps against sections the note was never written under.
    const guardSrc = readFileSync(new URL("../visit.service.ts", import.meta.url), "utf8");
    const guard = guardSrc.match(/WHERE t\.template_id = (COALESCE\([\s\S]*?is_active\s*LIMIT 1\)\))/)?.[1];
    expect(guard).toBeDefined();

    // Whitespace collapses (including the line break the sign guard puts
    // after its opening bracket) and the visit alias is normalised — the sign
    // guard calls it v, these two queries dv. Nothing else may differ.
    const norm = (s: string) =>
      s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\b(?:dv|v)\./g, "‹visit›.");

    await load({ visitId: VISIT });
    await load({ superbillId: SUPERBILL });
    const ours = calls
      .map((c) => c.sql.match(/COALESCE\((?:dv|v)\.note_template_id,[\s\S]*?is_active\s*LIMIT 1\)\)/)?.[0])
      .filter((e): e is string => Boolean(e));
    expect(ours).toHaveLength(2);
    for (const e of ours) expect(norm(e)).toBe(norm(guard!));
  });
});
