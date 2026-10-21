/**
 * Marking a claim denied has to RECORD a denial, not just change a status.
 *
 * markStatus('denied') used to set superbill.status and write an activity row,
 * and nothing else. superbill_denial — the table every denial metric reads, and
 * the only place the payer, the reason code and the denied amount live — was
 * written exclusively by the full log-a-denial flow, which the claims queue
 * does not go through. So the denial rate, the by-payer breakdown and the whole
 * "where those denials were" question the client asked for on 20 Aug 2026
 * [14:07] returned zero however many claims were denied.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text, matching
 * document-lock.spec.ts. The insert is the one statement this file models rows
 * for: it used to be covered by two greps for the words "NOT EXISTS" and
 * "FROM superbill_denial d" against a fake that held no rows at all, so
 * correlating the subquery on `d.id = s.id` — a denial's primary key against a
 * superbill's, which can never match — left the guard permanently false and all
 * 9 tests here (and all 71 in mark-status.spec.ts) green. The fake does not
 * answer the NOT EXISTS; it holds the rows and EVALUATES the correlation the
 * statement actually sent (see redenialGuard).
 *
 * WHICH CLAIMS IT WRITES FOR is held the same way, and for the same reason: the
 * statement is INSERT … SELECT … FROM superbill s WHERE …, so it writes one row
 * per row of the superbill TABLE that survives its own WHERE. Restated here as
 * `values.includes(superbill.id)` against a single hardcoded claim, widening
 * that scope to `WHERE (s.id = ? OR TRUE)` — one click of Denied on the claims
 * queue opening a denial on EVERY claim in the org that has none, each at its
 * full billed amount in the denial rate and the by-payer breakdown — passed
 * 11/11. The fake holds more than one claim and evaluates the scope the
 * statement sent (see claimScope).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { markStatus } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const SB = "b7121555-b0ca-4f57-b03f-a6c1c21c1789";
const OTHER_SB = "b7121555-b0ca-4f57-b03f-a6c1c21c1790";

/** A row of superbill_denial, as the queue's one-click Denied writes it. */
interface DenialRow {
  id: string;
  superbill_id: string;
  cpt_code: string;
  carc_code: string;
  decision: string;
  outcome: string;
}

let currentStatus: string;
let calls: string[] = [];
/** What superbill_denial holds. The guard's whole job is to keep it to one. */
let denials: DenialRow[] = [];

interface Superbill {
  id: string;
  org_id: string;
  cpt_codes: string[];
  billed_amount_cents: number;
}

const claim = (o: Partial<Superbill> & { id: string }): Superbill => ({
  org_id: ORG,
  cpt_codes: ["99344"],
  billed_amount_cents: 11401,
  ...o,
});

/** The columns a statement may name, so a typo or a new one fails loudly. */
const SUPERBILL_COLUMNS = Object.keys(claim({ id: "" }));
const DENIAL_COLUMNS: (keyof DenialRow)[] = [
  "id", "superbill_id", "cpt_code", "carc_code", "decision", "outcome",
];

/**
 * The claims on file. NEVER one: the INSERT names the superbill table, so how
 * many rows it writes is a property of its WHERE and of nothing else, and with
 * a single claim here a scope widened to `OR TRUE` had nothing to hit.
 */
let superbills: Superbill[] = [];

/** Number of values bound before `at` in the statement the service sent. */
const bindsBefore = (sql: string, at: number) => sql.slice(0, at).split("¶").length - 1;

/**
 * Comments blanked, every other character left where it stood so the bind
 * positions above still line up.
 */
function maskComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (c) => {
    if (c.includes("¶")) throw new Error(`fake cannot read a bound value inside a comment: ${c}`);
    return " ".repeat(c.length);
  });
}

/** The index of the ")" that closes the "(" at `open`. */
function closingParen(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`fake cannot read an unclosed "(" in: ${sql}`);
}

/** The ranges of `[from, to)` separated by `sep` at paren depth 0. */
function splitTop(sql: string, from: number, to: number, sep: string): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    else if (depth === 0 && sql.startsWith(sep, i)) {
      parts.push([start, i]);
      start = i + sep.length;
      i = start - 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

const column = (name: string, of: string[], clause: string): string => {
  if (!of.includes(name)) throw new Error(`fake holds no column "${name}" (clause: ${clause})`);
  return name;
};

/**
 * The insert's re-denial guard, EVALUATED from the statement the service sent:
 * a predicate that is true of a denial row `d` that stops claim `s` being
 * denied a second time.
 *
 * Not restated here, and not answered by a fixed true/false either. Restated,
 * the correlation could be changed to anything that never matches — or narrowed
 * with an extra condition — and this file would still be green while every trip
 * round denied → submitted → denied appended another UNCODED row carrying the
 * full billed amount, double-counting the claim in the denial rate, the
 * by-payer breakdown and the reason analysis. Each clause is `d.col = s.col`,
 * `d.col = 'literal'` or `d.col = <bound value>`; anything else throws rather
 * than being guessed at, so an unfamiliar rewrite fails loudly instead of
 * passing by accident.
 */
function redenialGuard(
  sql: string,
  values: unknown[],
  from: number,
  to: number,
): (d: DenialRow, s: Superbill) => boolean {
  const head = /^\s*SELECT\s+1\s+FROM\s+superbill_denial\s+d\s+WHERE\s+/.exec(sql.slice(from, to));
  if (!head) {
    throw new Error(`fake cannot read the re-denial guard: ${sql.slice(from, to).trim()}`);
  }
  const clauses = splitTop(sql, from + head[0].length, to, " AND ").map(([a, b]) => {
    const raw = sql.slice(a, b);
    const text = raw.replace(/\s+/g, " ").trim();
    const m = /^d\.(\w+) (=|<>) (?:s\.(\w+)|'([^']*)'|¶(?:::\w+)?)$/.exec(text);
    if (!m) throw new Error(`fake cannot evaluate the re-denial guard's clause: ${text}`);
    const [, col, op, sCol, literal] = m;
    const left = column(col!, DENIAL_COLUMNS, text) as keyof DenialRow;
    const right = sCol ? (column(sCol, SUPERBILL_COLUMNS, text) as keyof Superbill) : null;
    const value = literal ?? (right ? null : values[bindsBefore(sql, a + raw.indexOf("¶"))]);
    return (d: DenialRow, s: Superbill) =>
      op === "=" ? d[left] === (right ? s[right] : value) : d[left] !== (right ? s[right] : value);
  });
  return (d, s) => clauses.every((p) => p(d, s));
}

/**
 * A boolean condition out of the statement, as a predicate over the claims the
 * fake holds: AND, OR, parenthesised groups, TRUE/FALSE, `s.col = <bound>`,
 * `s.col = 'literal'`, and the NOT EXISTS above. Anything else throws.
 */
function parseCondition(
  sql: string,
  values: unknown[],
  from: number,
  to: number,
): (s: Superbill) => boolean {
  while (from < to && /\s/.test(sql[from]!)) from++;
  while (to > from && /\s/.test(sql[to - 1]!)) to--;
  if (sql[from] === "(" && closingParen(sql, from) === to - 1) {
    return parseCondition(sql, values, from + 1, to - 1);
  }
  // OR binds looser than AND, so it is split off first.
  for (const [sep, all] of [
    [" OR ", false],
    [" AND ", true],
  ] as const) {
    const parts = splitTop(sql, from, to, sep);
    if (parts.length > 1) {
      const ps = parts.map(([a, b]) => parseCondition(sql, values, a, b));
      return (s) => (all ? ps.every((p) => p(s)) : ps.some((p) => p(s)));
    }
  }
  const raw = sql.slice(from, to);
  const text = raw.replace(/\s+/g, " ").trim();
  if (/^TRUE$/i.test(text)) return () => true;
  if (/^FALSE$/i.test(text)) return () => false;
  if (/^NOT EXISTS \(/i.test(text)) {
    const open = from + raw.indexOf("(");
    const blocks = redenialGuard(sql, values, open + 1, closingParen(sql, open));
    // NOT EXISTS: the claim is written for only while no denial row on file
    // answers the correlation the statement sent.
    return (s) => !denials.some((d) => blocks(d, s));
  }
  const m = /^s\.(\w+) (=|<>) (?:¶(?:::\w+)?|'([^']*)')$/.exec(text);
  if (!m) throw new Error(`fake cannot evaluate the claim scope's clause: ${text}`);
  const [, col, op, literal] = m;
  const left = column(col!, SUPERBILL_COLUMNS, text) as keyof Superbill;
  const value = literal ?? values[bindsBefore(sql, from + raw.indexOf("¶"))];
  return (s) => (op === "=" ? s[left] === value : s[left] !== value);
}

/**
 * The claims the denial INSERT writes a row for, EVALUATED from its own
 * `FROM superbill s WHERE …` against every claim the fake holds — the way
 * Postgres would, with no scoping of the fake's own.
 */
function claimScope(sql: string, values: unknown[]): (s: Superbill) => boolean {
  const at = sql.indexOf("FROM superbill s");
  if (at < 0) throw new Error(`fake cannot find the denial insert's FROM superbill s: ${sql}`);
  const kw = sql.indexOf("WHERE ", at);
  if (kw < 0) throw new Error(`fake cannot find a WHERE after FROM superbill s: ${sql}`);
  const start = kw + "WHERE ".length;
  // The WHERE ends where the INSERT's own tail begins. Neither tail is on the
  // statement today; stopping here means adding one reads as what it is rather
  // than as a clause the fake cannot parse. The NOT EXISTS is what keeps the
  // second row off — an ON CONFLICT added beside it would need modelling here
  // before any count below could be read as the database's answer.
  let end = sql.length;
  for (const tail of ["ON CONFLICT", "RETURNING"]) {
    const i = sql.indexOf(tail, start);
    if (i >= 0) end = Math.min(end, i);
  }
  return parseCondition(sql, values, start, end);
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push(sql);
    if (sql.includes("SELECT status, provider_npi, visit_id FROM superbill")) {
      // One claim is marked per call, so `currentStatus` is that claim's.
      const s = superbills.find((x) => values.includes(x.id));
      return Promise.resolve(
        s && currentStatus ? [{ status: currentStatus, provider_npi: "1234567893", visit_id: "e0000000-0000-4000-8000-00000000000c" }] : [],
      );
    }
    if (sql.includes("INSERT INTO superbill_denial")) {
      // The statement is INSERT … SELECT … FROM superbill s WHERE …: it writes
      // one row per CLAIM that survives its own WHERE, so the claims on file
      // and the statement decide that between them, not this fake.
      const statement = maskComments(sql);
      const writesFor = claimScope(statement, values);
      // Every target is picked before any row is written, as Postgres decides
      // this INSERT against the table as it stood when the statement began.
      const targets = superbills.filter((s) => writesFor(s));
      for (const s of targets) {
        denials.push({
          id: `denial-${denials.length + 1}`,
          superbill_id: s.id,
          cpt_code: s.cpt_codes[0]!,
          // The queue has no EOB in front of it; the row is written UNCODED.
          carc_code: "UNCODED",
          decision: "pending",
          outcome: "pending",
        });
      }
      return Promise.resolve(targets.length);
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const denialInsert = () =>
  calls.find((s) => s.includes("INSERT INTO superbill_denial"));
const onBill = (id: string) => denials.filter((d) => d.superbill_id === id);

beforeEach(() => {
  calls = [];
  denials = [];
  // Two claims, both denial-free: the queue lists a practice's whole backlog,
  // so a claim beside the one clicked is the ordinary case, not an exotic one.
  superbills = [claim({ id: SB }), claim({ id: OTHER_SB, cpt_codes: ["99349"] })];
  currentStatus = "submitted";
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("markStatus → denied", () => {
  it("records a denial row, not just a status change", async () => {
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(denialInsert()).toBeTruthy();
    expect(onBill(SB)).toHaveLength(1);
  });

  it("records it on the claim that was clicked, and on no other claim on file", async () => {
    // `WHERE s.id = ?` is the whole of what holds this INSERT to one claim:
    // the statement selects FROM superbill, so a scope widened by an OR — or
    // bound to something other than the clicked claim — opens an UNCODED
    // denial on every claim in the org that has none, each carrying its full
    // billed amount into the denial rate and the by-payer breakdown.
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(onBill(SB)).toHaveLength(1);
    expect(onBill(OTHER_SB)).toHaveLength(0);

    // And it follows the claim clicked rather than always the first row.
    currentStatus = "submitted";
    await markStatus({ orgId: ORG, id: OTHER_SB, to: "denied" });
    expect(onBill(OTHER_SB)).toHaveLength(1);
    expect(denials).toHaveLength(2);
  });

  it("does not double-count when a refiled claim is denied again", async () => {
    // denied → submitted → denied is the normal correction loop. Without the
    // guard the same claim adds a denial row every time round, each carrying
    // COALESCE(s.billed_amount_cents, 0) into the denied-amount totals, and
    // /billing counts one claim two or three times.
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    currentStatus = "submitted"; // the team corrected the claim and refiled it
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(onBill(SB)).toHaveLength(1);
  });

  it("does not double-count once the team has DECIDED to refile the first denial", async () => {
    // In the real correction loop the team decides 'refile' on the first
    // denial — denial.service sets decision and refiled_at — before the claim
    // goes back out and is denied again. The test above leaves that first row
    // at decision 'pending', so it cannot tell the guard apart from one
    // narrowed to `AND d.decision = 'pending'`. That narrowing is the tempting
    // way to square the unconditional NOT EXISTS with the PARTIAL pending-unique
    // index, and it would write a second UNCODED row at the full billed amount
    // every time a refiled claim came back denied.
    denials = [
      { id: "decided", superbill_id: SB, cpt_code: "99344", carc_code: "16", decision: "refile", outcome: "pending" },
    ];
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(onBill(SB)).toHaveLength(1);
  });

  it("the guard is in the statement, and asks about THIS claim", async () => {
    // A text assertion, and named as one: it says the words are there, not
    // that they work. What they do is held by the two tests either side.
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    const sql = denialInsert()!;
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("FROM superbill_denial d");
  });

  it("CONTROL — a denial on ANOTHER claim does not stop this one being recorded", async () => {
    // The guard is about this claim's own history. Correlated on something
    // that matches any denial in the table, the first denial recorded from the
    // queue would be the last one Pallio ever recorded.
    denials = [
      { id: "someone-elses", superbill_id: OTHER_SB, cpt_code: "99344", carc_code: "UNCODED", decision: "pending", outcome: "pending" },
    ];
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(onBill(SB)).toHaveLength(1);
    expect(onBill(OTHER_SB)).toHaveLength(1);
  });

  it("marks the reason UNCODED rather than inventing a CARC", async () => {
    // The queue's one-click Denied has no EOB in front of it. Recording a real
    // reason code that nobody read off a remittance would be a fabrication in
    // the one field an appeal turns on.
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(denialInsert()).toContain("'UNCODED'");
  });

  it("copies the claim context off the superbill so it is frozen at denial time", async () => {
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    const sql = denialInsert()!;
    for (const col of ["payer_id", "cpt_code", "icd10_codes", "modifiers", "denied_amount_cents"]) {
      expect(sql).toContain(col);
    }
  });

  it("writes no denial for a claim of another org, though the id is the one clicked", async () => {
    // The status read above is not modelled per org here, so the INSERT's own
    // `s.org_id = ?` is what is under test: on a connection that bypasses RLS
    // it is the whole of what keeps one practice's Denied off another's claim.
    superbills = [claim({ id: SB, org_id: OTHER_ORG })];
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(denialInsert()).toBeTruthy();
    expect(denials).toEqual([]);
  });

  it("still writes the activity trail entry", async () => {
    await markStatus({ orgId: ORG, id: SB, to: "denied" });
    expect(calls.some((s) => s.includes("INSERT INTO superbill_activity"))).toBe(true);
  });

  for (const to of ["paid", "voided"] as const) {
    it(`does not record a denial when moving to ${to}`, async () => {
      currentStatus = to === "paid" ? "submitted" : "submitted";
      await markStatus({ orgId: ORG, id: SB, to });
      expect(denialInsert()).toBeUndefined();
      expect(denials).toEqual([]);
    });
  }

  it("refuses an illegal transition before touching anything", async () => {
    currentStatus = "paid";
    await expect(
      markStatus({ orgId: ORG, id: SB, to: "denied" }),
    ).rejects.toThrow(/illegal superbill transition/i);
    expect(denialInsert()).toBeUndefined();
  });

  it("404s a missing superbill", async () => {
    currentStatus = "";
    await expect(markStatus({ orgId: ORG, id: SB, to: "denied" })).rejects.toThrow(/not found/i);
  });
});
