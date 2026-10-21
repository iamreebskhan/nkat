/**
 * Posting a payer's 835 to the bills it names (audit R10).
 *
 * lib/db is mocked with a fake tx dispatching on SQL text, as in
 * mark-status.spec.ts. The status moves run through the REAL markStatusTx, so
 * these also hold the posting to the transition map (R26), the rendering-NPI
 * check (R40) and the audit rows (R24).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/observability/sentry", () => ({ reportError: vi.fn() }));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

import { parseEra835 } from "../era835-parser";
import { ingestRemittance } from "../remittance.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const FILE = "44444444-4444-4444-8444-444444444444";
const SB = "b2e303af-e2cb-4292-8d00-c35c07423a0d";
/** Another claim in the same org, carrying denials of its own. */
const OTHER_SB = "b2e303af-e2cb-4000-8000-000000000002";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const REFILED_DENIAL = "3cabb077-b8be-461c-b4d0-d823bf254651";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const DENY = fixture("deny.835");
const PAY = fixture("pay.835");
/** Pays 99344 and denies 99215 on the same claim: CLP04 $70.00 of $114.01. */
const PART = fixture("partial.835");
/**
 * The same denial with its CAS segment gone: CLP02 is still 4, so the claim is
 * denied, but the payer named no reason. deniedEntries() calls that line
 * UNCODED — the same word the queue's one-click Record denial writes on its
 * placeholder — so this is the one file whose denied line and whose placeholder
 * carry the SAME (CPT, CARC) pair, and the only one that can tell whether the
 * fill's NOT EXISTS excludes the row it is filling.
 */
const DENY_NO_CARC = DENY.replace(/CAS\*CO\*16\*114\.01~\r?\n/, "");

interface Bill {
  id: string;
  status: string;
  provider_npi: string | null;
  payer_id: string | null;
  visit_id: string | null;
  cpt_codes: string[];
  dos: string;
}

/**
 * The denial rows on the bill, as one model rather than a knob per query.
 *
 * The rows are what decide what the posting can do: which ones a payment may
 * settle, which one the reason-fill claims, and — through
 * superbill_denial_pending_unique_idx, (superbill_id, cpt_code, carc_code)
 * WHERE decision = 'pending' — whether an INSERT lands at all. The fake used to
 * return a fresh id for every insert, so a conflict could not happen here and
 * the cost of swallowing one could not be shown.
 */
interface Denial {
  id: string;
  /**
   * The org the row belongs to. RLS scopes these statements to it, so every row
   * the fake holds is in it — which is what makes a bill scope widened to
   * `OR d.org_id = ?` visible here: it selects the whole tenant's denials.
   */
  org_id: string;
  /**
   * The bill the row is on. No handler below assumes a statement is scoped to
   * it: each one selects rows by EVALUATING the WHERE clause the service sent
   * (see rowsMatching), so a lost bill scope selects other bills' rows here
   * exactly as it would in Postgres. The reason-fill's guard correlates on it
   * too: a guard that lost `o.superbill_id = d.superbill_id` would stand aside
   * for the same code and reason open on ANY bill in the org.
   */
  superbill_id: string;
  cpt_code: string;
  carc_code: string;
  decision: string;
  outcome: string;
  refiled_at: Date | null;
  /** What was recorded as recovered when this denial was closed. */
  outcome_amount_cents: number | null;
  /** How the closure was explained — the biller's words, or Pallio's. */
  outcome_notes: string | null;
}

let bills: Bill[];
let fileIsNew: boolean;
/** claim_seq → postings already on file for it. */
let prior: Record<number, string[]>;
let denials: Denial[];
/** A claim ref whose match query throws, and what it throws. */
let throwFor: { prefix: string; err: Error } | null;
/** The bill's latest refile, as the stale-file check reads it. */
let lastRefile: Date | null;
/** What the documentation gate reads (audit R19); null = no row. */
let docFacts: Record<string, unknown> | null;
let docReqs: { code: string; required_chart_elements: string[] }[];
let calls: { sql: string; values: unknown[] }[];
let active: number;
let maxActive: number;

const bill = (o: Partial<Bill> = {}): Bill => ({
  id: SB,
  status: "submitted",
  provider_npi: "1234567893",
  payer_id: null,
  visit_id: VISIT,
  cpt_codes: ["99344"],
  dos: "2026-06-09",
  ...o,
});

/** An open denial the team logged and has not decided: the ordinary case. */
const denial = (o: Partial<Denial> & { id: string }): Denial => ({
  org_id: ORG,
  superbill_id: SB,
  cpt_code: "99344",
  carc_code: "16",
  decision: "pending",
  outcome: "pending",
  refiled_at: null,
  outcome_amount_cents: null,
  outcome_notes: null,
  ...o,
});

/** The columns a statement may name, so a typo or a new one fails loudly. */
const DENIAL_COLUMNS = Object.keys(denial({ id: "" }));

/** One the team decided to refile and sent out again. */
const refiled = () =>
  denial({ id: REFILED_DENIAL, decision: "refile", refiled_at: new Date("2026-09-01T00:00:00Z") });

function setStatus(id: unknown, to: unknown) {
  const b = bills.find((x) => x.id === id);
  if (b) b.status = String(to);
}

/** The statement as Prisma sends it, with each bound value shown as `?`. */
const asSent = (sql: string) => sql.replaceAll("¶", "?");
const sqlOf = (c: { sql: string }) => asSent(c.sql);

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

/**
 * The reason-fill's NOT EXISTS, EVALUATED from the statement the service sent:
 * a predicate that is true of a row `o` that makes the fill of row `d` stand
 * aside.
 *
 * Restated here, the guard could lose a clause with every test still green.
 * Only `o.id <> d.id` used to be read from the text — the clause that did go
 * missing from the shipped statement after a crash — while the bill, the
 * code-and-reason match and the decision/outcome pair were the fake's own, so
 * dropping any of them from the SQL left this file green (the pair was caught
 * only by one pinned fragment of its text). Evaluated, a clause dropped from
 * the SQL is dropped here too, and a narrowed one is narrowed here, so the
 * tests below go red on what the fill then does. Each clause is `o.col = d.col`,
 * `o.col <> d.col`, `o.col = 'literal'`, `o.col = <bound value>` or a
 * parenthesised OR of those; anything else throws rather than being guessed
 * at, and the throw surfaces as a claim error, which the guard's tests assert
 * there is none of.
 */
function fillGuard(sql: string, values: unknown[]): (o: Denial, d: Denial) => boolean {
  const opening = "NOT EXISTS (";
  const start = sql.indexOf(opening);
  // No guard: nothing ever makes the fill stand aside.
  if (start < 0) return () => false;
  let depth = 0;
  let end = start + opening.length - 1;
  for (; end < sql.length; end++) {
    if (sql[end] === "(") depth++;
    else if (sql[end] === ")" && --depth === 0) break;
  }
  // The values bound inside the subquery follow the SET list's.
  let next = sql.slice(0, start).split("¶").length - 1;
  const body = sql
    .slice(start + opening.length, end)
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const head = "SELECT 1 FROM superbill_denial o WHERE ";
  if (!body.startsWith(head)) throw new Error(`fake cannot read the reason-fill's guard: ${body}`);
  const atom = (text: string) => {
    const m = /^o\.(\w+) (=|<>) (?:d\.(\w+)|'([^']*)'|(¶))$/.exec(text);
    if (!m) throw new Error(`fake cannot evaluate the reason-fill's guard clause: ${text}`);
    const [, col, op, dCol, literal, bound] = m;
    const value = bound ? values[next++] : literal;
    return (o: Denial, d: Denial) => {
      const left = o[col as keyof Denial];
      const right = dCol ? d[dCol as keyof Denial] : value;
      return op === "=" ? left === right : left !== right;
    };
  };
  const clauses = splitOutsideParens(body.slice(head.length), " AND ").map((clause) => {
    if (!clause.startsWith("(")) return atom(clause);
    const either = splitOutsideParens(clause.slice(1, -1), " OR ").map(atom);
    return (o: Denial, d: Denial) => either.some((p) => p(o, d));
  });
  return (o, d) => clauses.every((p) => p(o, d));
}

/**
 * The value bound at the `¶` inside the first match of `re` — read from the
 * statement, so a value that moves, or a clause that takes its bind away, is
 * read as the service sent it rather than by counting arguments here.
 */
function bound(sql: string, values: unknown[], re: RegExp): unknown {
  const m = re.exec(sql);
  if (!m) throw new Error(`fake cannot find ${re} in: ${sql}`);
  const at = m.index + m[0].indexOf("¶");
  return values[sql.slice(0, at).split("¶").length - 1];
}

/** A superbill_denial column the fake holds, or a loud failure. */
function denialColumn(name: string, context: string): keyof Denial {
  if (!DENIAL_COLUMNS.includes(name)) {
    throw new Error(`fake holds no superbill_denial column "${name}" (${context})`);
  }
  return name as keyof Denial;
}

/**
 * What the settle stamps on a settling row as recovered, EVALUATED from the
 * statement's own CASE expression: the column the payer's per-line payments are
 * keyed by, and the column its "the only denial settling for this line" window
 * partitions on.
 *
 * Restated — paidByCode indexed by the row's `cpt_code` here whatever the SQL
 * says — the key could be changed to `s.id` with nothing but a grep for the
 * words `::jsonb ->> s.cpt_code)::bigint` noticing, while every settled denial
 * took an amount belonging to another line or none at all. That key and that
 * partition are the whole of the fix this expression is: without them the
 * claim's CLP04 total went onto EVERY open denial, and two denials on one bill
 * reported $197.00 recovered against a single $98.50 payment.
 */
function recoveredCents(
  sql: string,
  values: unknown[],
): (d: Denial, settling: Denial[]) => number | null {
  const text = sql.replace(/\s+/g, " ");
  const key = /\(¶::jsonb ->> (?:\w+\.)?(\w+)\)::bigint/.exec(text);
  if (!key) throw new Error(`fake cannot read the settle's recovered amount: ${text}`);
  const keyed = denialColumn(key[1]!, `in: ${key[0]}`);
  const paidBy = JSON.parse(String(bound(sql, values, /¶::jsonb/) ?? "{}")) as Record<string, number>;
  // No window at all and every settling row takes the lookup's value, which is
  // what the statement then means: the same figure on each of them.
  const window = /count\(\*\) OVER \(PARTITION BY (?:\w+\.)?(\w+)\) = 1/.exec(text);
  const partition = window ? denialColumn(window[1]!, `in: ${window[0]}`) : null;
  return (d, settling) => {
    if (partition && settling.filter((o) => o[partition] === d[partition]).length !== 1) return null;
    const paid = paidBy[String(d[keyed])];
    return paid === undefined ? null : paid;
  };
}

/** The WHERE body of the statement at or after `from`, and where it starts. */
function whereBody(sql: string, from: string): { body: string; start: number } {
  const at = sql.indexOf(from);
  if (at < 0) throw new Error(`fake cannot find "${from}" in: ${sql}`);
  const kw = sql.indexOf("WHERE ", at);
  if (kw < 0) throw new Error(`fake cannot find a WHERE after "${from}" in: ${sql}`);
  const start = kw + "WHERE ".length;
  let depth = 0;
  let end = start;
  for (; end < sql.length; end++) {
    if (sql[end] === "(") depth++;
    else if (sql[end] === ")") {
      // The close of the CTE the statement's SELECT sits in.
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && /^(ORDER BY|LIMIT|FOR UPDATE|RETURNING|GROUP BY)\b/.test(sql.slice(end))) {
      break;
    }
  }
  return { body: sql.slice(start, end), start };
}

/**
 * The rows a statement SELECTS or UPDATES, decided by EVALUATING the WHERE
 * clause the service sent against every denial row the fake holds — the way
 * Postgres would, with no table scoping of the fake's own.
 *
 * Restated in JS instead, a row selection can lose a condition with every test
 * still green, and that is precisely what these statements did: the settle's
 * bill scope and its `d.outcome = 'pending'` filter could each be deleted, the
 * reason-fill's placeholder pick widened to claim a denial the biller coded
 * themselves or one already refiled, and the open-denial lookup's bill scope
 * inverted — all with 54 tests passing, because the fake filtered
 * `onBill(values[0])` by rules it held itself. Evaluated, a clause dropped from
 * the SQL is dropped here, a widened one widens here, and the tests below go
 * red on what the posting then does to the rows.
 *
 * It understands only the atoms these statements use: `col = ?`, `col <> ?`,
 * `col = 'literal'`, `col IS [NOT] NULL`, `[NOT] (col = ANY(?::text[]))`,
 * `TRUE`, and parenthesised ORs of those, each optionally qualified by the
 * statement's alias. Anything else throws rather than being guessed at — the
 * same fail-loud shape as fillGuard — and the throw surfaces as a claim error,
 * which these tests assert there is none of.
 */
function rowsMatching(sql: string, values: unknown[], from: string): Denial[] {
  const { body, start } = whereBody(sql, from);
  let next = sql.slice(0, start).split("¶").length - 1;
  const take = () => values[next++];
  const atom = (text: string): ((d: Denial) => boolean) => {
    const col = (name: string) => denialColumn(name, `clause: ${text}`);
    let m: RegExpExecArray | null;
    if (/^TRUE$/i.test(text)) return () => true;
    if ((m = /^(NOT )?\(?(?:\w+\.)?(\w+) = ANY\(¶(?:::\w+(?:\[\])?)?\)\)?$/.exec(text))) {
      const c = col(m[2]!);
      const negated = Boolean(m[1]);
      const list = take() as unknown[];
      return (d) => list.includes(d[c]) !== negated;
    }
    if ((m = /^(?:\w+\.)?(\w+) IS (NOT )?NULL$/.exec(text))) {
      const c = col(m[1]!);
      const negated = Boolean(m[2]);
      return (d) => (d[c] === null) !== negated;
    }
    if ((m = /^(?:\w+\.)?(\w+) (=|<>) (?:'([^']*)'|¶(?:::\w+(?:\[\])?)?)$/.exec(text))) {
      const c = col(m[1]!);
      const value = m[3] === undefined ? take() : m[3];
      return (d) => (m![2] === "=" ? d[c] === value : d[c] !== value);
    }
    throw new Error(`fake cannot evaluate the row selection's clause: ${text}`);
  };
  const clauses = splitOutsideParens(
    body.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim(),
    " AND ",
  ).map((clause) => {
    // `NOT (...)` is an atom; `(a OR b)` is a group.
    if (!clause.startsWith("(")) return atom(clause);
    const either = splitOutsideParens(clause.slice(1, -1), " OR ").map(atom);
    return (d: Denial) => either.some((p) => p(d));
  });
  return denials.filter((d) => clauses.every((p) => p(d)));
}

function fakeTx() {
  /** The rows on the bill a statement names. */
  const onBill = (id: unknown) => denials.filter((d) => d.superbill_id === id);
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("INSERT INTO remittance_file")) return Promise.resolve(fileIsNew ? [{ id: FILE }] : []);
    if (sql.includes("SELECT id FROM remittance_file")) return Promise.resolve([{ id: FILE }]);
    if (sql.includes("SELECT posting FROM era_835_record")) {
      return Promise.resolve((prior[values[1] as number] ?? []).map((posting) => ({ posting })));
    }
    if (sql.includes("WHERE id BETWEEN")) {
      const [lo, hi] = values as string[];
      if (throwFor && lo!.startsWith(throwFor.prefix)) return Promise.reject(throwFor.err);
      return Promise.resolve(bills.filter((b) => b.id >= lo! && b.id <= hi!).map((b) => ({ ...b })));
    }
    if (sql.includes("member_id_snapshot = ")) return Promise.resolve([]);
    // The stale-file check's refile lookup, and the documentation gate's reads.
    if (sql.includes("kind = 'resubmitted'")) return Promise.resolve([{ at: lastRefile }]);
    if (sql.includes("FROM superbill sb")) return Promise.resolve(docFacts ? [docFacts] : []);
    if (sql.includes("FROM documentation_requirement")) return Promise.resolve(docReqs);
    // markStatusTx's locked read and its writes. A write names its bill by the
    // value bound after `WHERE id =`; the org is bound after it.
    if (sql.includes("SELECT status, provider_npi, visit_id FROM superbill")) {
      const b = bills.find((x) => x.id === values[0]);
      return Promise.resolve(b ? [{ status: b.status, provider_npi: b.provider_npi, visit_id: b.visit_id }] : []);
    }
    if (sql.includes("UPDATE superbill SET status = 'submitted'")) {
      setStatus(bound(sql, values, /WHERE id = ¶/),"submitted");
      return Promise.resolve(1);
    }
    if (sql.includes("paid_at = now()")) {
      setStatus(bound(sql, values, /WHERE id = ¶/),values[0]);
      return Promise.resolve(1);
    }
    if (sql.includes("UPDATE superbill SET status = ")) {
      setStatus(bound(sql, values, /WHERE id = ¶/),values[0]);
      return Promise.resolve(1);
    }
    // Denials, against the rows in `denials`. The settle goes first: it is the
    // one statement led by a CTE, and its text carries fragments the checks
    // below also look for.
    if (sql.includes("outcome_amount_cents = r.cents")) {
      // WHICH ROWS IT TAKES IS THE STATEMENT'S, not restated here. Restated,
      // all three of its conditions could go: the exclusion — which is the
      // whole of the fix — the bill scope, and `d.outcome = 'pending'`, each
      // leaving the settle re-stamping rows it must not touch, with every test
      // in this file still passing. Evaluated, those deletions settle the same
      // extra rows here, and the tests below go red on what that does to them.
      const settling = rowsMatching(sql, values, "FROM superbill_denial d");
      // WHAT IT STAMPS AS RECOVERED is the statement's too (see
      // recoveredCents): which line's payment each row takes, and whether it
      // may take one at all, are read out of the CASE the service sent rather
      // than restated here.
      const recovered = recoveredCents(sql, values);
      const outcome = String(bound(sql, values, /\boutcome = ¶/));
      const notes = String(bound(sql, values, /\boutcome_notes = ¶/));
      return Promise.resolve(
        settling.map((d) => {
          d.outcome = outcome;
          d.outcome_notes = notes;
          // What the payer paid on that row's line, and only when it is the one
          // denial settling for it. BIGINT reads back as a BigInt.
          const paid = recovered(d, settling);
          d.outcome_amount_cents = paid;
          return { id: d.id, outcome_amount_cents: paid === null ? null : BigInt(paid) };
        }),
      );
    }
    // The reason-fill's placeholder pick. Dispatched on the lock it takes and
    // the table it reads — NOT on any of the conditions under test, which the
    // fake used to key on: a widening that kept the substring
    // "carc_code = 'UNCODED' AND refiled_at IS NULL" was then invisible, while
    // writing the same two clauses the other way round turned nine tests red.
    if (sql.includes("SELECT id FROM superbill_denial") && sql.includes("FOR UPDATE")) {
      const candidates = rowsMatching(sql, values, "FROM superbill_denial");
      // ORDER BY (cpt_code = ?) DESC, created_at — the placeholder already on
      // the line this file denies, and otherwise the oldest. `denials` is in
      // created_at order. Read from the statement, again: ordered by age alone
      // the fill re-points a placeholder off the line the payer ruled on.
      const prefersDeniedLine = asSent(sql).includes("ORDER BY (cpt_code = ?) DESC, created_at");
      const preferred = prefersDeniedLine
        ? candidates.find((d) => d.cpt_code === bound(sql, values, /ORDER BY \(cpt_code = ¶\)/))
        : undefined;
      const row = preferred ?? candidates[0];
      return Promise.resolve(row ? [{ id: row.id }] : []);
    }
    if (sql.includes("'secondary_denial'")) {
      // Which rows this closes is the statement's too: without that, its
      // "only the ones that were refiled" scope could go, and every pending
      // denial on the bill would close as a secondary denial — work nobody did.
      const closed = rowsMatching(sql, values, "UPDATE superbill_denial SET");
      const notes = String(bound(sql, values, /\boutcome_notes = ¶/));
      for (const d of closed) {
        d.outcome = "secondary_denial";
        d.outcome_notes = notes;
      }
      return Promise.resolve(closed.map((d) => ({ id: d.id })));
    }
    if (sql.includes("UPDATE superbill_denial d SET")) {
      // The reason-fill. Its NOT EXISTS is evaluated from the statement (see
      // fillGuard), over every row the fake holds, on this bill or not.
      const [code, carc] = values as [string, string];
      const row = denials.find((d) => values.includes(d.id));
      if (!row) return Promise.resolve([]);
      const standsAside = fillGuard(sql, values);
      if (denials.some((o) => standsAside(o, row))) return Promise.resolve([]);
      // superbill_denial_pending_unique_idx, as Postgres enforces it on this
      // UPDATE: a guard narrowed so that it no longer sees an undecided row on
      // the same line and reason does not fill in silence, it fails the claim.
      const clash =
        row.decision === "pending" &&
        onBill(row.superbill_id).some(
          (o) => o !== row && o.decision === "pending" && o.cpt_code === code && o.carc_code === carc,
        );
      if (clash) {
        return Promise.reject(
          new Error('duplicate key value violates unique constraint "superbill_denial_pending_unique_idx"'),
        );
      }
      row.cpt_code = code;
      row.carc_code = carc;
      return Promise.resolve([{ id: row.id }]);
    }
    // Before the open-denial lookup below it: the INSERT's `prior` CTE reads a
    // row by cpt_code and carc_code too, so that check would swallow it.
    if (sql.includes("INSERT INTO superbill_denial")) {
      const [billId, code, carc] = values as [string, string, string];
      const clash = onBill(billId).find(
        (d) => d.decision === "pending" && d.cpt_code === code && d.carc_code === carc,
      );
      if (clash) {
        // superbill_denial_pending_unique_idx. DO NOTHING returns nothing and
        // the denial is gone; DO UPDATE takes the row and hands its id back —
        // with what `prior` saw on it, when the statement asks for that.
        if (!sql.includes("DO UPDATE")) return Promise.resolve([]);
        const asksForPrior = sql.includes("p.outcome AS prior_outcome");
        const was = { outcome: clash.outcome, amount: clash.outcome_amount_cents };
        clash.outcome = "pending";
        clash.outcome_amount_cents = null;
        clash.outcome_notes = null;
        return Promise.resolve([
          {
            id: clash.id,
            prior_outcome: asksForPrior ? was.outcome : null,
            prior_amount_cents:
              asksForPrior && was.amount !== null ? BigInt(was.amount) : null,
          },
        ]);
      }
      const row = denial({
        id: `opened-${denials.length + 1}`, superbill_id: billId, cpt_code: code, carc_code: carc,
      });
      denials.push(row);
      return Promise.resolve([{ id: row.id, prior_outcome: null, prior_amount_cents: null }]);
    }
    // The "already open on this bill" check. Its scope is the statement's as
    // well: restated here, it could be widened to any bill in the org, or
    // inverted outright, and this file stayed green — a denial open on someone
    // else's claim would then suppress opening this one, and the posting note
    // would tell the biller it was already on record.
    if (sql.includes("SELECT id FROM superbill_denial")) {
      // ORDER BY created_at LIMIT 1; `denials` is in created_at order.
      const row = rowsMatching(sql, values, "FROM superbill_denial")[0];
      return Promise.resolve(row ? [{ id: row.id }] : []);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  bills = [bill()];
  fileIsNew = true;
  prior = {};
  denials = [];
  throwFor = null;
  lastRefile = null;
  docFacts = null;
  docReqs = [];
  calls = [];
  active = 0;
  maxActive = 0;
  vi.mocked(withOrgContext).mockReset();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await Promise.resolve();
      return await (fn as (tx: unknown) => Promise<unknown>)(fakeTx());
    } finally {
      active -= 1;
    }
  });
});

const upload = (text: string, filename = "remit.835") =>
  ingestRemittance({ orgId: ORG, userId: USER, filename, text });

const find = (frag: string) => calls.filter((c) => c.sql.includes(frag));
/**
 * The "already open on this bill" lookup, located by the SHAPE of the statement
 * — a plain read of superbill_denial, with none of the reason-fill's
 * FOR UPDATE — rather than by the wording of the conditions under test. Keyed
 * on the fragment `AND cpt_code = `, a pure REORDER of its four clauses, with
 * nothing changed but their order, made the locator return nothing and the test
 * below died of `Cannot read properties of undefined (reading 'sql')`: a crash
 * reported against a statement that still does exactly what it did.
 */
const openDenialLookups = () =>
  calls.filter(
    (c) => c.sql.includes("SELECT id FROM superbill_denial") && !c.sql.includes("FOR UPDATE"),
  );
const eraRows = () => find("INSERT INTO era_835_record");
const superbillWrites = () => find("UPDATE superbill SET");
// Statements that write: a SELECT ... FOR UPDATE is a read. WITH counts, for
// the settle, which is a CTE-led UPDATE.
const denialWrites = () =>
  calls.filter(
    (c) => c.sql.includes("superbill_denial") && /^\s*(INSERT|UPDATE|WITH)\b/.test(c.sql),
  );
const trail = () =>
  find("INSERT INTO superbill_activity").map((c) =>
    c.values.find((v): v is string => typeof v === "string" && v.includes(" ") && !v.startsWith("{")),
  );
const audits = (action: string) => find("INSERT INTO audit_log").filter((c) => c.values.includes(action));
const payloadOf = (c: { values: unknown[] }) =>
  JSON.parse(String(c.values.find((v) => typeof v === "string" && v.startsWith("{"))));

describe("ingestRemittance — posting a payment", () => {
  it("posts a matched Claim ref: paid_source 'remittance' and $98.50, a linked 'paid' line, open denials settled", async () => {
    denials = [denial({ id: "open-denial" })];
    const r = await upload(PAY);

    const paid = find("paid_at = now()")[0]!;
    expect(paid.values).toContain("paid");
    expect(paid.values).toContain(9850);
    expect(paid.values).toContain("remittance");

    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("paid");
    expect(line.values).toContain("LOCAL-PAY-1");

    const settle = find("UPDATE superbill_denial SET").find((c) => !c.sql.includes("secondary"))!;
    expect(settle.values).toContain("paid");
    // $98.50 still, but carried as the payer's payment for the line the denial
    // is on, not as the claim total the settle used to stamp on every row.
    expect(settle.values).toContain(JSON.stringify({ "99344": 9850 }));
    expect(payloadOf(audits("denial_outcome")[0]!)).toEqual({
      outcome: "paid", visitId: VISIT, amountCents: 9850, source: "remittance",
    });

    expect(r).toMatchObject({ fileId: FILE, alreadyUploaded: false });
    expect(r.counts).toMatchObject({ claims: 2, paid: 1, unmatched: 1, paidCents: 9850 });
  });

  it("writes the payer's word on the trail, citing the trace number", async () => {
    await upload(PAY);
    expect(trail()).toContain("Paid — $98.50, per payer remittance LOCAL-PAY-1");
  });

  it("steps a denied bill through submitted; the documentation gate (R19) reads the claim but does not block", async () => {
    bills = [bill({ status: "denied" })];
    await upload(PAY);
    expect(trail()).toEqual([
      "Submission confirmed by payer remittance LOCAL-PAY-1",
      "Paid — $98.50, per payer remittance LOCAL-PAY-1",
    ]);
    // Changed on purpose (review finding): the gate is read now, and a gap is
    // recorded rather than enforced. This claim has no payer standard on file,
    // so the trail reads as before.
    expect(find("FROM superbill sb")).toHaveLength(1);
    expect(bills[0]!.status).toBe("paid");
  });

  it("holds a bill with no rendering-provider NPI for review, and moves nothing (R40)", async () => {
    bills = [bill({ status: "denied", provider_npi: "" })];
    const r = await upload(PAY);
    expect(superbillWrites()).toHaveLength(0);
    expect(r.counts).toMatchObject({ paid: 0, needsReview: 1, unmatched: 1 });
    expect(r.needsReview[0]!.note).toMatch(/no rendering-provider NPI/);
    expect(bills[0]!.status).toBe("denied");
  });

  it("holds a DRAFT bill for review instead of inventing a review (R26)", async () => {
    bills = [bill({ status: "draft" })];
    const r = await upload(PAY);
    expect(superbillWrites()).toHaveLength(0);
    expect(r.needsReview[0]!.note).toMatch(/still a draft/);
    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("needs_review");
  });

  it("holds a claim whose date of service is not the bill's", async () => {
    bills = [bill({ dos: "2026-06-10" })];
    const r = await upload(PAY);
    expect(superbillWrites()).toHaveLength(0);
    expect(r.needsReview[0]!.note).toMatch(/date of service/);
  });

  it("holds a ref that matches two bills", async () => {
    bills = [bill(), bill({ id: "b2e303af-e2cb-4000-8000-000000000001" })];
    const r = await upload(PAY);
    expect(superbillWrites()).toHaveLength(0);
    expect(r.needsReview[0]!.note).toMatch(/More than one bill/);
  });
});

describe("ingestRemittance — an unmatched claim", () => {
  it("writes no superbill change and one 'unmatched' line with no superbill", async () => {
    bills = [];
    const r = await upload(PAY);
    expect(superbillWrites()).toHaveLength(0);
    expect(denialWrites()).toHaveLength(0);
    const unmatched = eraRows().filter((c) => c.values.includes("unmatched"));
    expect(unmatched).toHaveLength(2);
    // payer_id and superbill_id are the first two values after the fixed columns.
    for (const row of unmatched) expect(row.values.slice(4, 6)).toEqual([null, null]);
    expect(r.unmatched).toEqual([
      { claimId: "B2E303AFE2CB", dos: "2026-06-09", billedCents: 11401, paidCents: 9850 },
      { claimId: "NOPE00000001", dos: "2026-06-01", billedCents: 5000, paidCents: 5000 },
    ]);
  });
});

describe("ingestRemittance — uploading the same file again", () => {
  it("posts nothing twice: every claim already posted means no superbill or denial write", async () => {
    fileIsNew = false;
    prior = { 1: ["denied"] };
    const r = await upload(DENY);
    expect(r.alreadyUploaded).toBe(true);
    expect(r.counts).toMatchObject({ claims: 1, alreadyPosted: 1, denied: 0 });
    expect(superbillWrites()).toHaveLength(0);
    expect(denialWrites()).toHaveLength(0);
    expect(eraRows()).toHaveLength(0);
    expect(find("DELETE FROM era_835_record")).toHaveLength(0);
  });

  it("retries a claim that was held for review: its rows are replaced and it posts", async () => {
    fileIsNew = false;
    prior = { 1: ["needs_review"] };
    const r = await upload(DENY);
    const del = find("DELETE FROM era_835_record")[0]!;
    expect(del.values).toEqual([FILE, 1]);
    expect(r.counts.denied).toBe(1);
    expect(eraRows()[0]!.values).toContain("denied");
  });
});

describe("ingestRemittance — a denial", () => {
  it("closes a refiled denial as secondary and opens a coded one from the file — never an UNCODED row", async () => {
    denials = [refiled()];
    const r = await upload(DENY);

    expect(find("UPDATE superbill SET status = ").some((c) => c.values[0] === "denied")).toBe(true);
    expect(find("'secondary_denial'")).toHaveLength(1);
    expect(payloadOf(audits("denial_outcome")[0]!)).toMatchObject({
      outcome: "secondary_denial", source: "remittance",
    });

    const inserts = find("INSERT INTO superbill_denial");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).not.toContain("'UNCODED'");
    expect(inserts[0]!.sql).toContain("'remittance'");
    expect(inserts[0]!.values).toEqual(expect.arrayContaining(["16", "M51", "CO", 11401, "99344"]));

    expect(trail()).toEqual([
      "Denied by the payer, per remittance LOCAL-DENY-1",
      "Denial reason per payer remittance LOCAL-DENY-1 — CARC 16 (CO) on 99344",
    ]);
    expect(r.counts).toMatchObject({ claims: 1, denied: 1, unmatched: 0 });
  });

  it("fills in the reason on the queue's UNCODED row when that denial was never refiled", async () => {
    bills = [bill({ status: "denied" })];
    denials = [denial({ id: "uncoded-row", carc_code: "UNCODED" })];
    await upload(DENY);
    // Denied → denied: the reason only, no status move.
    expect(superbillWrites()).toHaveLength(0);
    const fill = find("UPDATE superbill_denial d SET")[0]!;
    expect(fill.values).toEqual(expect.arrayContaining(["uncoded-row", "16", "M51", "CO", 11401]));
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
    expect(find("'secondary_denial'")).toHaveLength(0);
  });

  it("closes only the denials that were REFILED, and leaves the rest open", async () => {
    bills = [bill({ status: "submitted", cpt_codes: ["99344", "99349"] })];
    // One denial went back out to the payer and this file is the answer to it.
    // The other is open work the biller has not acted on, and nothing here
    // answers it. Closing every pending row on the bill stamps that one
    // "Denied again per payer remittance" with a denial_outcome audit row
    // saying so, and it leaves the queue as work somebody did.
    denials = [
      refiled(),
      denial({ id: "logged-and-not-acted-on", cpt_code: "99349", carc_code: "50" }),
    ];
    const r = await upload(DENY);

    expect(r.errors).toEqual([]);
    expect(denials.find((d) => d.id === REFILED_DENIAL)).toMatchObject({
      outcome: "secondary_denial",
      outcome_notes: "Denied again per payer remittance LOCAL-DENY-1",
    });
    expect(denials.find((d) => d.id === "logged-and-not-acted-on")).toMatchObject({
      outcome: "pending", outcome_notes: null,
    });
    const outcomes = audits("denial_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.values).toContain(REFILED_DENIAL);
  });

  it("leaves a placeholder on a claim already refiled to the secondary-denial close", async () => {
    bills = [bill({ status: "submitted" })];
    // The queue's UNCODED row was decided and sent back out before any reason
    // was recorded. The fill is for a denial still awaiting its reason, not one
    // the payer has now answered a second time: claimed by the fill, this row
    // is re-dated as the current denial, no secondary denial is recorded, and
    // the refile's own outcome is never written.
    denials = [
      denial({
        id: "refiled-placeholder", carc_code: "UNCODED",
        decision: "refile", refiled_at: new Date("2026-09-01T00:00:00Z"),
      }),
    ];
    const r = await upload(DENY);

    expect(r.errors).toEqual([]);
    expect(find("UPDATE superbill_denial d SET")).toHaveLength(0);
    expect(denials.find((d) => d.id === "refiled-placeholder")).toMatchObject({
      carc_code: "UNCODED", outcome: "secondary_denial",
    });
    expect(find("INSERT INTO superbill_denial")).toHaveLength(1);
  });

  it("stamps the reason's trail entry with clock_timestamp(), so it cannot tie with the status move", async () => {
    await upload(DENY);
    const reason = find("INSERT INTO superbill_activity").find((c) =>
      c.sql.includes("'denial_logged'"),
    )!;
    // The status move and this entry are written in ONE transaction, and the
    // column's now() default is the transaction's START — so both would carry
    // the same `at`, and the claim history's ORDER BY at DESC, id DESC then
    // tie-breaks on a random uuid: the payer's reason listed above the denial
    // it explains, about half the time. Nothing else in the repo asserts this.
    //
    // This pins the statement's own text and no more: the fake has no clock, so
    // the ordering the stamp exists to protect is not exercised here. The other
    // half of it — the claim history's ORDER BY — lives in superbill.service.ts.
    expect(reason.sql).toContain("summary, detail, at");
    expect(reason.sql).toMatch(/,\s*clock_timestamp\(\)\s*\)/);
  });
});

describe("ingestRemittance — no PHI from the file", () => {
  it("never writes the patient's name or member id anywhere", async () => {
    // CONTROL: the file does carry them, so a leak would show.
    expect(DENY).toContain("SINGLETON");
    expect(parseEra835(DENY).claims[0]!.patient_external_id).toBe("TESTMEMBER1");

    await upload(DENY);
    const everything = JSON.stringify(calls.map((c) => c.values));
    for (const phi of ["SINGLETON", "STEPHEN", "TESTMEMBER1"]) expect(everything).not.toContain(phi);
    for (const row of eraRows()) {
      expect(row.sql).toMatch(/client_id, patient_external_id, raw_segment[\s\S]*NULL, NULL, NULL/);
    }
  });

  it("uses a member id only as a match key, for a claim that carries no Claim ref", async () => {
    const noRef = DENY.replace("CLP*B2E303AFE2CB", "CLP*ACCT-77");
    const r = await upload(noRef);
    expect(find("member_id_snapshot = ")[0]!.values).toContain("TESTMEMBER1");
    // Statements that write. The match SELECT ends in FOR UPDATE, so a bare
    // /UPDATE/ would count the one place the member id is meant to be.
    for (const c of calls.filter((x) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(x.sql))) {
      expect(JSON.stringify(c.values)).not.toContain("TESTMEMBER1");
    }
    expect(r.counts.unmatched).toBe(1);
  });
});

describe("ingestRemittance — the audit row", () => {
  it("writes remittance_post on the file, with counts only", async () => {
    await upload(PAY);
    const row = audits("remittance_post")[0]!;
    expect(row.values).toContain("remittance");
    expect(row.values).toContain(FILE);
    const payload = payloadOf(row);
    expect(Object.keys(payload).sort()).toEqual(
      [
        "alreadyPosted", "alreadyUploaded", "claims", "denied", "errors",
        "needsReview", "paid", "partiallyPaid", "totalPaidCents", "unmatched",
      ].sort(),
    );
    for (const v of Object.values(payload)) expect(["number", "boolean"]).toContain(typeof v);
    expect(payload).toMatchObject({ claims: 2, paid: 1, unmatched: 1, totalPaidCents: 9850 });
  });

  it("records the posted status change as coming from the remittance (R24)", async () => {
    await upload(PAY);
    const change = audits("superbill_status_change")[0]!;
    expect(payloadOf(change)).toMatchObject({
      from: "submitted", to: "paid", visitId: VISIT, paidAmountCents: 9850,
      source: "remittance", remittanceFileId: FILE,
    });
  });
});

describe("ingestRemittance — one claim at a time", () => {
  const TWO = [
    "ISA*00*          *00*          *ZZ*PAYER123       *ZZ*PROVIDER456    *260914*1300*^*00501*000000103*0*P*:~",
    "ST*835*0103~",
    "TRN*1*LOCAL-TWO-1*1234567890~",
    "CLP*AAAAAAAAAAAA*1*10.00*10.00*0*MC*PCN-A~",
    "SVC*HC:99349*10.00*10.00**1~",
    "DTM*472*20260609~",
    "CLP*B2E303AFE2CB*1*114.01*98.50*0*MC*PCN-B~",
    "SVC*HC:99344*114.01*98.50**1~",
    "DTM*472*20260609~",
    "SE*9*0103~",
  ].join("\n");

  it("records a claim that throws as an error, and the later claims still post", async () => {
    throwFor = { prefix: "aaaaaaaa-aaaa", err: new Error("connection reset: raw driver text") };
    const r = await upload(TWO);
    expect(r.errors).toEqual([
      { claimId: "AAAAAAAAAAAA", message: "This claim could not be posted. Upload the file again to retry it." },
    ]);
    expect(JSON.stringify(r)).not.toContain("raw driver text");
    expect(r.counts).toMatchObject({ claims: 2, errors: 1, paid: 1 });
    // Held for review on the file, so the next upload retries it.
    expect(eraRows().some((c) => c.values.includes("needs_review") && c.values.includes(1))).toBe(true);
    expect(bills[0]!.status).toBe("paid");
  });

  it("echoes a typed refusal's own message", async () => {
    throwFor = { prefix: "aaaaaaaa-aaaa", err: new ValidationError("Illegal superbill transition paid → paid.") };
    const r = await upload(TWO);
    expect(r.errors[0]!.message).toBe("Illegal superbill transition paid → paid.");
  });

  it("opens one transaction per claim, one after another, never in parallel", async () => {
    await upload(TWO);
    // The file, each of the two claims, then the audit row.
    expect(vi.mocked(withOrgContext)).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(1);
  });
});

describe("ingestRemittance — refusing what is not an 835", () => {
  it("refuses a file with no ST*835 and one with no claims, writing nothing", async () => {
    await expect(upload("hello, this is a CSV")).rejects.toThrow(/not an 835/);
    await expect(upload("ST*835*0001~SE*1*0001~")).rejects.toThrow(/no claims/);
    expect(vi.mocked(withOrgContext)).not.toHaveBeenCalled();
  });
});

describe("ingestRemittance — a file older than the bill's latest refile", () => {
  // DENY is dated 2026-09-14 (BPR16). The team recorded the denial and refiled
  // it, so the bill is submitted again; then the ERA for that ORIGINAL denial
  // is uploaded.
  beforeEach(() => {
    bills = [bill({ status: "submitted" })];
    denials = [refiled()];
  });

  it("holds a denial dated before the refile for review: no status move, no secondary denial, no new denial", async () => {
    lastRefile = new Date("2026-09-15T03:41:34Z");
    const r = await upload(DENY);
    expect(superbillWrites()).toHaveLength(0);
    expect(denialWrites()).toHaveLength(0);
    expect(bills[0]!.status).toBe("submitted");
    expect(r.counts).toMatchObject({ claims: 1, denied: 0, needsReview: 1 });
    expect(r.needsReview[0]!.note).toBe(
      "This remittance is dated 2026-09-14, on or before this claim was refiled (2026-09-15), so it answers the claim as first filed, not the corrected one still with the payer. Compare it with the claim history and post it by hand if it still applies.",
    );
    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("needs_review");
  });

  it("holds one dated on the refile day itself", async () => {
    lastRefile = new Date("2026-09-14T15:00:00Z");
    const r = await upload(DENY);
    expect(superbillWrites()).toHaveLength(0);
    expect(r.counts.needsReview).toBe(1);
  });

  it("reads the refile from the denials and from the claim's trail", async () => {
    lastRefile = new Date("2026-09-15T03:41:34Z");
    await upload(DENY);
    const q = find("kind = 'resubmitted'")[0]!;
    expect(q.sql).toContain("GREATEST");
    expect(q.sql).toContain("max(d.refiled_at)");
    expect(q.values).toEqual([SB, SB]);
  });

  it("holds a payment dated before the refile too: the corrected claim is still with the payer", async () => {
    lastRefile = new Date("2026-09-15T03:41:34Z");
    const r = await upload(PAY);
    expect(find("paid_at = now()")).toHaveLength(0);
    expect(r.needsReview[0]!.note).toMatch(/on or before this claim was refiled/);
  });

  it("holds a file with no payment date (BPR16) on a refiled bill", async () => {
    const noDate = DENY.replace("NON************20260914~", "NON~");
    expect(parseEra835(noDate).header.payment_date).toBeUndefined();
    lastRefile = new Date("2026-09-10T12:00:00Z");
    const r = await upload(noDate);
    expect(superbillWrites()).toHaveLength(0);
    expect(r.needsReview[0]!.note).toMatch(/carries no payment date \(BPR16\)/);
  });

  it("CONTROL — a denial dated after the refile still closes the refile as a secondary denial and opens the coded one", async () => {
    lastRefile = new Date("2026-09-10T12:00:00Z");
    const r = await upload(DENY);
    expect(bills[0]!.status).toBe("denied");
    expect(find("'secondary_denial'")).toHaveLength(1);
    expect(find("INSERT INTO superbill_denial")).toHaveLength(1);
    expect(r.counts).toMatchObject({ denied: 1, needsReview: 0 });
  });

  it("CONTROL — a bill never refiled posts as before, even from a file with no payment date", async () => {
    denials = [];
    const r = await upload(DENY.replace("NON************20260914~", "NON~"));
    expect(r.counts).toMatchObject({ denied: 1, needsReview: 0 });
  });
});

describe("ingestRemittance — a denial already on record", () => {
  it("opens no second denial when the same code and reason are open under a decision (an appeal)", async () => {
    bills = [bill({ status: "denied" })];
    denials = [denial({ id: "appealed-denial", decision: "appeal" })];
    const r = await upload(DENY);
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
    expect(superbillWrites()).toHaveLength(0);
    // No reason line on the trail: the reason was already there.
    expect(trail()).toEqual([]);
    const match = openDenialLookups()[0]!;
    expect(match.sql).toContain("outcome = 'pending'");
    // Under ANY decision: the check does not filter on it.
    expect(match.sql).not.toContain("decision");
    // Each value read from the clause that binds it, and nothing else bound:
    // the same three conditions, in whatever order they are written.
    expect(bound(match.sql, match.values, /superbill_id = ¶/)).toBe(SB);
    expect(bound(match.sql, match.values, /\bcpt_code = ¶/)).toBe("99344");
    expect(bound(match.sql, match.values, /\bcarc_code = ¶/)).toBe("16");
    expect(match.values).toHaveLength(3);
    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("denied");
    expect(line.values).toContain(
      "Denied — CARC 16 (CO); 1 denial was already open in Pallio and not opened again",
    );
    expect(r.counts.denied).toBe(1);
  });

  it("opens nothing twice when the same ERA comes back under a new envelope", async () => {
    // The first upload denied the bill and opened CARC 16 on 99344. The
    // re-download has a new sha256, so it is a new file to Pallio.
    bills = [bill({ status: "denied" })];
    denials = [denial({ id: "first-upload-denial" })];
    await upload(DENY.replaceAll("000000101", "000000901"));
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
  });

  it("the UNCODED fill stands aside for an open row under any decision too, and leaves it alone", async () => {
    bills = [bill({ status: "denied" })];
    // TWO rows: the appealed one already carries CARC 16 on 99344, which is
    // what this file denies. With only the placeholder in the setup the fill
    // always SUCCEEDED, so its guard was asserted as SQL text and exercised by
    // nothing — the fake could have stopped applying it and stayed green.
    denials = [
      denial({ id: "uncoded-row", carc_code: "UNCODED" }),
      denial({ id: "appealed-row", decision: "appeal" }),
    ];
    const r = await upload(DENY);
    // Standing aside is not failing: a fill that threw would leave the same
    // untouched rows behind.
    expect(r.errors).toEqual([]);
    expect(find("UPDATE superbill_denial d SET")[0]!.sql).toContain(
      "(o.decision = 'pending' OR o.outcome = 'pending')",
    );
    expect(denials.find((d) => d.id === "uncoded-row")).toMatchObject({
      cpt_code: "99344", carc_code: "UNCODED", outcome: "pending",
    });
    // The team's row stands, and no second row is opened for the same denial.
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
    expect(trail()).toEqual([]);
  });

  it("fills the placeholder from a file that names no reason, rather than standing aside for itself", async () => {
    bills = [bill({ status: "denied" })];
    // The file's denied line is UNCODED on 99344 and so is the placeholder, so
    // the fill's NOT EXISTS sees a row carrying "this reason" — ITSELF. Only
    // `o.id <> d.id` keeps it out. Without it the fill refuses in silence and
    // the placeholder keeps no RARC, no group code and no denied amount, while
    // the posting counts the row as already open and says nothing new happened.
    denials = [denial({ id: "uncoded-row", carc_code: "UNCODED" })];
    await upload(DENY_NO_CARC);

    // The payer's line reaches the row: its RARC and the $114.01 it denied.
    // 'UNCODED' keeps a bare reason — the catalog has no text for it.
    expect(find("UPDATE superbill_denial d SET")[0]!.values).toEqual(
      expect.arrayContaining(["uncoded-row", "99344", "UNCODED", "M51", 11401]),
    );
    // Filled, so the bill's history carries this file's reason. Refused, the
    // recording finds the placeholder still open, counts it and records nothing.
    expect(trail()).toEqual([
      "Denial reason per payer remittance LOCAL-DENY-1 — CARC UNCODED on 99344",
    ]);
    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("Denied — no reason code in the file");
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
  });

  // The next four each hold one clause of the fill's NOT EXISTS by what the
  // fill then does; fillGuard evaluates the clauses from the statement itself.

  it("stands aside for an undecided row a payment closed, which still holds the pending-unique slot", async () => {
    bills = [bill({ status: "denied" })];
    // Nobody decided it, so its decision is 'pending' and it holds
    // superbill_denial_pending_unique_idx for (bill, 99344, 16) although its
    // outcome is closed. `o.decision = 'pending'` is the half of the guard that
    // sees it. Cut down to `o.outcome = 'pending'`, the fill writes 16 on 99344
    // onto a second undecided row and Postgres fails the whole claim.
    denials = [
      denial({ id: "uncoded-row", carc_code: "UNCODED" }),
      denial({ id: "closed-by-a-payment", outcome: "paid" }),
    ];
    const r = await upload(DENY);
    expect(r.errors).toEqual([]);
    expect(r.counts.denied).toBe(1);
    expect(denials).toHaveLength(2);
    expect(denials.find((d) => d.id === "uncoded-row")).toMatchObject({ carc_code: "UNCODED" });
    // The payer's reason goes to the row that holds it, open again.
    expect(denials.find((d) => d.id === "closed-by-a-payment")!.outcome).toBe("pending");
  });

  it("fills the placeholder though a decided, closed denial once carried this reason", async () => {
    bills = [bill({ status: "denied" })];
    // An appeal that ended in a secondary denial is history: decided, closed
    // and off the pending-unique index. Drop the decision/outcome pair from the
    // guard and the fill stands aside for it anyway — the placeholder keeps no
    // reason and the same denial is opened a second time beside it.
    denials = [
      denial({ id: "uncoded-row", carc_code: "UNCODED" }),
      denial({ id: "appeal-lost", decision: "appeal", outcome: "secondary_denial" }),
    ];
    const r = await upload(DENY);
    expect(r.errors).toEqual([]);
    expect(denials.find((d) => d.id === "uncoded-row")).toMatchObject({
      cpt_code: "99344", carc_code: "16", outcome: "pending",
    });
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
  });

  it("fills the placeholder beside open denials that share only its line, or only its reason", async () => {
    bills = [bill({ status: "denied", cpt_codes: ["99344", "99349"] })];
    // Neither is this file's denial: CARC 97 is another reason on 99344, and
    // CARC 16 on 99349 is this reason on another line. Lose either half of the
    // guard's code-and-reason match and one of them stands in the way — the
    // placeholder keeps no reason and the denial is opened a second time.
    denials = [
      denial({ id: "uncoded-row", carc_code: "UNCODED" }),
      denial({ id: "other-reason-same-line", carc_code: "97" }),
      denial({ id: "same-reason-other-line", cpt_code: "99349" }),
    ];
    const r = await upload(DENY);
    expect(r.errors).toEqual([]);
    expect(denials.find((d) => d.id === "uncoded-row")).toMatchObject({
      cpt_code: "99344", carc_code: "16",
    });
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
  });

  it("fills the placeholder though another bill has the same denial open", async () => {
    bills = [bill({ status: "denied" })];
    // CARC 16 on 99344 is an everyday denial, open on many bills at once. The
    // guard asks about THIS bill; lose `o.superbill_id = d.superbill_id` and a
    // placeholder is filled only in an org with no such denial open anywhere.
    denials = [
      denial({ id: "uncoded-row", carc_code: "UNCODED" }),
      denial({ id: "on-another-bill", superbill_id: OTHER_SB }),
    ];
    const r = await upload(DENY);
    expect(r.errors).toEqual([]);
    expect(denials.find((d) => d.id === "uncoded-row")).toMatchObject({
      cpt_code: "99344", carc_code: "16",
    });
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
  });

  // The next three hold the reason-fill's placeholder pick and the open-denial
  // lookup by what the posting DOES to rows they must not touch. Both used to
  // be restated by this fake, so both could be widened in the statement — to
  // any UNCODED-or-not row, to a closed one, to another claim's — and every
  // test here still passed.

  it("opens the payer's line as new work beside a denial the biller coded themselves", async () => {
    bills = [bill({ status: "denied", cpt_codes: ["99344", "99350"] })];
    // No placeholder on this bill: the biller logged a DIFFERENT denial with
    // the payer's reason typed in, and another claim has one awaiting its
    // reason. The fill takes an UNCODED row on THIS bill and nothing else.
    // Widened, it rewrites the biller's 99350/97 row to this file's 99344/16 —
    // their record of a different denial destroyed in place, with no audit row
    // naming what was overwritten — and the real 99344 denial is never opened.
    denials = [
      denial({ id: "biller-coded", cpt_code: "99350", carc_code: "97" }),
      denial({ id: "another-claims-placeholder", superbill_id: OTHER_SB, carc_code: "UNCODED" }),
    ];
    const r = await upload(DENY);

    expect(r.errors).toEqual([]);
    expect(find("UPDATE superbill_denial d SET")).toHaveLength(0);
    expect(denials.find((d) => d.id === "biller-coded")).toMatchObject({
      cpt_code: "99350", carc_code: "97", outcome: "pending",
    });
    expect(denials.find((d) => d.id === "another-claims-placeholder")).toMatchObject({
      cpt_code: "99344", carc_code: "UNCODED",
    });
    const opened = find("INSERT INTO superbill_denial");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.values).toEqual(expect.arrayContaining(["99344", "16"]));
  });

  it("leaves an UNCODED row a payment already closed out of the fill", async () => {
    bills = [bill({ status: "denied" })];
    // The placeholder was settled by an earlier payment and carries what was
    // recovered. It is history, not a row awaiting its reason: filled, the
    // biller's $98.50 keeps a reason that answers a different denial, and the
    // payer's re-denial is never opened as work.
    denials = [
      denial({
        id: "uncoded-and-settled", carc_code: "UNCODED", outcome: "paid",
        outcome_amount_cents: 9850, outcome_notes: "Paid $98.50, per the EOB",
      }),
    ];
    const r = await upload(DENY);

    expect(r.errors).toEqual([]);
    expect(find("UPDATE superbill_denial d SET")).toHaveLength(0);
    expect(denials.find((d) => d.id === "uncoded-and-settled")).toMatchObject({
      cpt_code: "99344", carc_code: "UNCODED", outcome: "paid",
      outcome_amount_cents: 9850, outcome_notes: "Paid $98.50, per the EOB",
    });
    expect(find("INSERT INTO superbill_denial")).toHaveLength(1);
  });

  it("opens this bill's denial though the same one is open on another claim", async () => {
    // CARC 16 on 99344 is an everyday denial. The check asks whether it is open
    // on THIS bill; scoped to the org instead, this claim's denial is counted
    // as already on record, the queue never gets a row for it, and the file's
    // line tells the biller it was already there.
    denials = [denial({ id: "on-another-bill", superbill_id: OTHER_SB })];
    const r = await upload(DENY);

    const opened = find("INSERT INTO superbill_denial");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.values).toEqual(expect.arrayContaining(["99344", "16"]));
    expect(denials.find((d) => d.id === "on-another-bill")).toMatchObject({ outcome: "pending" });
    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("Denied — CARC 16 (CO)");
    expect(r.counts.denied).toBe(1);
  });

  it("CONTROL — with no open denial for that code and reason, the coded denial is still opened", async () => {
    const r = await upload(DENY);
    expect(find("INSERT INTO superbill_denial")).toHaveLength(1);
    expect(trail()).toContain("Denial reason per payer remittance LOCAL-DENY-1 — CARC 16 (CO) on 99344");
    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("Denied — CARC 16 (CO)");
    // A fresh row cleared no closure, so nothing claims one was cleared.
    expect(audits("denial_outcome")).toHaveLength(0);
    expect(r.counts.denied).toBe(1);
  });
});

describe("ingestRemittance — a partial payment that denies a line", () => {
  it("posts the payment and opens the payer's denied line, saying both on the file's line", async () => {
    const r = await upload(PART);

    const paid = find("paid_at = now()")[0]!;
    expect(paid.values).toContain("partially_paid");
    expect(paid.values).toContain(7000);
    expect(paid.values).toContain("remittance");
    expect(bills[0]!.status).toBe("partially_paid");

    const opened = find("INSERT INTO superbill_denial");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.values).toEqual(expect.arrayContaining(["99215", "16", "M51", "CO", 4401]));
    expect(trail()).toEqual([
      "Partially paid — $70.00, per payer remittance LOCAL-PART-1",
      "Denial reason per payer remittance LOCAL-PART-1 — CARC 16 (CO) on 99215",
    ]);

    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain("partially_paid");
    expect(line.values).toContain("Paid $70.00; 1 line denied — CARC 16 (CO)");
    expect(r.counts).toMatchObject({ claims: 1, partiallyPaid: 1, denied: 0, paidCents: 7000 });
  });

  it("leaves the payer's own re-denial open, and settles only what the payment answered", async () => {
    denials = [
      denial({ id: "re-denied", cpt_code: "99215", carc_code: "16" }),
      denial({ id: "answered", cpt_code: "99344", carc_code: "50" }),
    ];
    const r = await upload(PART);

    // The line THIS file denies is not "settled by the payment": it is the open
    // work the biller has to act on. Closed, the payer's re-denial existed
    // nowhere — its only row read as paid, on a bill showing partially paid.
    expect(denials.find((d) => d.id === "re-denied")!.outcome).toBe("pending");
    expect(denials.find((d) => d.id === "answered")!.outcome).toBe("partially_paid");
    const outcomes = audits("denial_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.values).toContain("answered");
    expect(payloadOf(outcomes[0]!)).toEqual({
      outcome: "partially_paid", visitId: VISIT, amountCents: 7000, source: "remittance",
    });

    // Not opened a second time either — and the file's line says so, rather
    // than leaving a biller who finds no new row on the queue to guess.
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
    const line = eraRows().find((c) => c.values.includes(SB))!;
    expect(line.values).toContain(
      "Paid $70.00; 1 line denied — CARC 16 (CO); 1 denial was already open in Pallio and not opened again",
    );
    expect(r.counts).toMatchObject({ partiallyPaid: 1, paidCents: 7000 });
  });

  it("keeps the payer's own line out of the settle in the STATEMENT, not only in this fake", async () => {
    denials = [denial({ id: "re-denied", cpt_code: "99215", carc_code: "16" })];
    await upload(PART);
    const settle = find("UPDATE superbill_denial SET").find((c) => !c.sql.includes("secondary"))!;
    // The exclusion IS the fix, and it lives in the SQL. Dropped from the
    // statement while the same values stayed bound, the settle closed every
    // open row again — the exact bug — and nothing here noticed.
    expect(sqlOf(settle)).toContain("AND NOT (d.cpt_code = ANY(?::text[]))");
    expect(settle.values).toContainEqual(["99215"]);
  });

  it("leaves the denied line open whatever reason code the bill's own denial carries", async () => {
    // Keyed on the pair (line, reason) this row settled — and was stamped
    // "recovered $0.00", because $0.00 is what the payer paid on the line it
    // denied. The payer's word is about the LINE: it has just said 99215 is
    // unpaid, so no denial on 99215 was answered by this payment.
    denials = [denial({ id: "same-line-other-carc", cpt_code: "99215", carc_code: "97" })];
    await upload(PART);
    expect(denials.find((d) => d.id === "same-line-other-carc")!.outcome).toBe("pending");
    expect(audits("denial_outcome")).toHaveLength(0);
    // This file's own reason opens beside it: CARC 16 is not CARC 97.
    expect(find("INSERT INTO superbill_denial")[0]!.values).toEqual(
      expect.arrayContaining(["99215", "16"]),
    );
  });

  it("holds the queue's UNCODED row out of the settle by filling it first, with this file's reason", async () => {
    denials = [denial({ id: "uncoded-row", cpt_code: "99215", carc_code: "UNCODED" })];
    await upload(PART);
    // Settled, it would have been counted as ended in the payment AND a second
    // row opened for the same denial — the double count the fill exists to stop.
    // Filled first, the row carries the line this file denies, and the settle's
    // own rule leaves it alone.
    expect(audits("denial_outcome")).toHaveLength(0);
    expect(find("UPDATE superbill_denial d SET")[0]!.values).toEqual(
      expect.arrayContaining(["uncoded-row", "99215", "16", "M51", "CO", 4401]),
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ carc_code: "16", outcome: "pending" });
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
  });

  it("settles a placeholder the fill REFUSED, which a blanket hold-back left open forever", async () => {
    denials = [
      denial({ id: "placeholder", cpt_code: "99344", carc_code: "UNCODED" }),
      denial({ id: "appealed", cpt_code: "99215", carc_code: "16", decision: "appeal" }),
    ];
    await upload(PART);
    // The fill claims ONE row and stands aside when another already carries the
    // payer's reason — here the appealed 16 on 99215. Held back from the settle
    // as a class, this placeholder ended pending with no outcome recorded
    // anywhere, where the payment used to close it.
    expect(denials.find((d) => d.id === "placeholder")).toMatchObject({
      carc_code: "UNCODED",
      outcome: "partially_paid",
    });
    expect(payloadOf(audits("denial_outcome")[0]!)).toEqual({
      outcome: "partially_paid", visitId: VISIT, amountCents: 7000, source: "remittance",
    });
    // The appealed row is on the line the payer denied: still open work.
    expect(denials.find((d) => d.id === "appealed")!.outcome).toBe("pending");
  });

  it("fills the placeholder on the line the payer denied, and the payment settles the other", async () => {
    denials = [
      denial({ id: "placeholder-on-a-paid-line", cpt_code: "99344", carc_code: "UNCODED" }),
      denial({ id: "placeholder-on-the-denied-line", cpt_code: "99215", carc_code: "UNCODED" }),
    ];
    await upload(PART);
    // Held back as a class, the one the fill never claims was left pending for
    // ever. Taken by age alone, the fill re-points a placeholder off the line
    // the payer ruled on and strands the other just the same.
    expect(denials.find((d) => d.id === "placeholder-on-the-denied-line")).toMatchObject({
      cpt_code: "99215", carc_code: "16", outcome: "pending",
    });
    expect(denials.find((d) => d.id === "placeholder-on-a-paid-line")).toMatchObject({
      cpt_code: "99344", carc_code: "UNCODED", outcome: "partially_paid",
    });
    expect(payloadOf(audits("denial_outcome")[0]!)).toEqual({
      outcome: "partially_paid", visitId: VISIT, amountCents: 7000, source: "remittance",
    });
    expect(find("INSERT INTO superbill_denial")).toHaveLength(0);
  });

  it("re-points a lone placeholder at the line the payer denied, rather than 'recovering' it", async () => {
    denials = [denial({ id: "placeholder", cpt_code: "99344", carc_code: "UNCODED" })];
    await upload(PART);
    // The placeholder is the queue's "denied, reason to follow" row, and it
    // carries the bill's FIRST code, not a line the payer ruled on. This file
    // says which line was denied, so that is the row's line, and it is open
    // work. Closed by the $70.00 on 99344 instead, Pallio would report a denial
    // recovered on a line that was never denied and open a second row for
    // 99215 beside it — one denial counted twice, one of them falsely paid.
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ cpt_code: "99215", carc_code: "16", outcome: "pending" });
    expect(audits("denial_outcome")).toHaveLength(0);
    expect(trail()).toContain(
      "Denial reason per payer remittance LOCAL-PART-1 — CARC 16 (CO) on 99215",
    );
  });

  it("CONTROL — a denial on a line the payer PAID is still settled by that payment", async () => {
    denials = [denial({ id: "answered", cpt_code: "99344", carc_code: "50" })];
    await upload(PART);
    expect(denials.find((d) => d.id === "answered")!.outcome).toBe("partially_paid");
    expect(audits("denial_outcome")).toHaveLength(1);
  });
});

describe("ingestRemittance — what a settled denial records as recovered", () => {
  it("stamps each denial with the payer's payment for ITS line, never the claim total", async () => {
    denials = [
      denial({ id: "on-the-paid-line", cpt_code: "99344", carc_code: "16" }),
      denial({ id: "on-another-line", cpt_code: "99349", carc_code: "50" }),
    ];
    await upload(PAY);
    const recovered = audits("denial_outcome").map(payloadOf);
    expect(recovered).toEqual([
      { outcome: "paid", visitId: VISIT, amountCents: 9850, source: "remittance" },
      // The file paid nothing on that line, so there is nothing honest to put
      // here. NULL is what recordOutcome writes when a person names no amount.
      { outcome: "paid", visitId: VISIT, amountCents: null, source: "remittance" },
    ]);
    // The whole point: two denials on one bill must not report $197.00 back
    // from a single $98.50 payment.
    expect(recovered.reduce((sum, p) => sum + (p.amountCents ?? 0), 0)).toBe(9850);
    // Per line in the statement itself, not only in what this fake hands back.
    const settle = find("UPDATE superbill_denial SET").find((c) => !c.sql.includes("secondary"))!;
    expect(settle.sql).toContain("::jsonb ->> s.cpt_code)::bigint");
  });

  it("records no amount on either when two denials are open on the same line", async () => {
    denials = [
      denial({ id: "carc-16", cpt_code: "99344", carc_code: "16" }),
      denial({ id: "carc-97", cpt_code: "99344", carc_code: "97" }),
    ];
    await upload(PAY);
    // How the payer's $98.50 splits between two reasons on one line is the
    // payer's word, not ours to invent; a person records it.
    expect(audits("denial_outcome").map((a) => payloadOf(a).amountCents)).toEqual([null, null]);
    // That "only one" is the statement's rule, not this fake's.
    const settle = find("UPDATE superbill_denial SET").find((c) => !c.sql.includes("secondary"))!;
    expect(settle.sql).toContain("count(*) OVER (PARTITION BY s.cpt_code) = 1");
  });
});

describe("ingestRemittance — which denials a payment may settle", () => {
  it("leaves a denial that was already closed exactly as the person who closed it left it", async () => {
    // recordOutcome writes the outcome and the amount and never touches
    // `decision`, so a denial a biller closed BY HAND — "paid, $98.50, per the
    // EOB" — is still on the bill beside the open one. Settling it again
    // re-stamps its outcome, its note and its amount from this file: the
    // recorded recovery is gone, /billing's recovery total moves, and the
    // denial_outcome audit row asserts the new figure as fact.
    denials = [
      denial({ id: "still-open" }),
      denial({
        id: "closed-by-a-person", carc_code: "50", outcome: "paid",
        outcome_amount_cents: 9850, outcome_notes: "Paid $98.50, per the EOB",
      }),
    ];
    await upload(PAY);

    expect(denials.find((d) => d.id === "closed-by-a-person")).toMatchObject({
      outcome: "paid", outcome_amount_cents: 9850, outcome_notes: "Paid $98.50, per the EOB",
    });
    const outcomes = audits("denial_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.values).toContain("still-open");
    expect(payloadOf(outcomes[0]!)).toEqual({
      outcome: "paid", visitId: VISIT, amountCents: 9850, source: "remittance",
    });
  });

  it("settles nothing on another claim, whatever else is open in the org", async () => {
    // RLS scopes these statements to the org, so a settle widened past this
    // bill reaches the whole tenant's denials queue: one 835 line closes every
    // pending denial in it and writes a denial_outcome audit row for each.
    denials = [
      denial({ id: "on-this-bill" }),
      denial({ id: "on-another-bill", superbill_id: OTHER_SB }),
    ];
    await upload(PAY);

    expect(denials.find((d) => d.id === "on-another-bill")).toMatchObject({
      outcome: "pending", outcome_amount_cents: null, outcome_notes: null,
    });
    const outcomes = audits("denial_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.values).toContain("on-this-bill");
  });
});

describe("ingestRemittance — a denial the pending-unique index blocks", () => {
  it("takes the conflict instead of dropping it: the line is open again, with the payer's reason", async () => {
    bills = [bill({ status: "denied" })];
    // Nobody decided this one, so decision is still 'pending' and it occupies
    // superbill_denial_pending_unique_idx — while an earlier payment closed its
    // outcome, which is why the open-denial check above it cannot see it.
    denials = [denial({ id: "closed-by-an-earlier-payment", outcome: "paid" })];
    const r = await upload(DENY);

    const insert = find("INSERT INTO superbill_denial")[0]!;
    expect(insert.sql).toContain(
      "ON CONFLICT (superbill_id, cpt_code, carc_code) WHERE decision = 'pending'",
    );
    expect(insert.sql).toContain("DO UPDATE SET");
    // Targetless DO NOTHING returned no row and said nothing: no denial, no
    // trail entry, and a payer's re-denial the biller never saw.
    expect(denials).toHaveLength(1);
    expect(denials[0]!.outcome).toBe("pending");
    expect(trail()).toContain(
      "Denial reason per payer remittance LOCAL-DENY-1 — CARC 16 (CO) on 99344",
    );
    expect(r.counts).toMatchObject({ denied: 1, needsReview: 0 });
  });

  it("says what closure it cleared off a denial a PERSON had closed", async () => {
    bills = [bill({ status: "denied" })];
    // recordOutcome writes the outcome and the amount and never touches
    // `decision`, so a denial a biller closed by hand — "paid, $98.50, per the
    // EOB" — is still decision 'pending', still occupies the pending-unique
    // index, and is the row this conflict lands on. Re-opened in silence, that
    // $98.50 of recorded recovery was gone with nothing anywhere saying so.
    denials = [denial({ id: "closed-by-a-person", outcome: "paid", outcome_amount_cents: 9850 })];
    await upload(DENY);

    expect(denials[0]).toMatchObject({ outcome: "pending", outcome_amount_cents: null });
    expect(audits("denial_outcome").map(payloadOf)).toEqual([
      {
        outcome: "pending", visitId: VISIT, amountCents: null, source: "remittance",
        clearedOutcome: "paid", clearedAmountCents: 9850,
      },
    ]);
    // On the claim history too, where the biller who recorded it will look.
    const reason = find("INSERT INTO superbill_activity").find((c) =>
      c.sql.includes("'denial_logged'"),
    )!;
    expect(payloadOf(reason).reopened).toEqual([
      { id: "closed-by-a-person", outcome: "paid", amountCents: 9850 },
    ]);
  });
});

describe("ingestRemittance — a payment on a partially paid bill", () => {
  it("holds it for review rather than overwrite the partial payment already recorded", async () => {
    bills = [bill({ status: "partially_paid" })];
    const r = await upload(PAY);
    expect(find("paid_at = now()")).toHaveLength(0);
    expect(find("UPDATE superbill_denial SET")).toHaveLength(0);
    expect(bills[0]!.status).toBe("partially_paid");
    expect(r.needsReview[0]!.note).toMatch(/partial payment is already recorded/);
    expect(r.counts).toMatchObject({ paid: 0, needsReview: 1, paidCents: 0 });
  });

  it("CONTROL — a payment on a submitted bill still posts", async () => {
    const r = await upload(PAY);
    expect(find("paid_at = now()")[0]!.values).toContain(9850);
    expect(r.counts).toMatchObject({ paid: 1, paidCents: 9850 });
  });
});

describe("ingestRemittance — a documentation gap on a claim the payer processed (R19)", () => {
  const FACTS = {
    is_telehealth: false, telehealth_modality: null, total_minutes: 45, dx_count: 1,
    dos: new Date("2026-06-09T00:00:00Z"), state: "OH",
    payer_id: "a0000000-0000-4000-8000-000000000302", payer_name: "Test Payer",
    codes: ["99344"],
    filled_keys: ["hpi", "physical_exam", "assessment_and_plan"],
    template_keys: ["chief_complaint", "hpi", "physical_exam", "assessment_and_plan"],
    has_vitals: true,
  };

  it("posts the claim, and records the gap on the trail and in the audit row as element names", async () => {
    bills = [bill({ status: "ready_to_submit" })];
    docFacts = FACTS;
    docReqs = [{ code: "99344", required_chart_elements: ["chief_complaint"] }];
    await upload(PAY);
    expect(bills[0]!.status).toBe("paid");
    expect(trail()[0]).toBe(
      "Submission confirmed by payer remittance LOCAL-PAY-1 — with a documentation gap (Chief complaint)",
    );
    const submitted = audits("superbill_status_change").map(payloadOf).find((p) => p.to === "submitted");
    expect(submitted.documentationGap).toEqual(["chief_complaint"]);
  });

  it("CONTROL — with the note complete, the step records no gap", async () => {
    bills = [bill({ status: "ready_to_submit" })];
    docFacts = { ...FACTS, filled_keys: [...FACTS.filled_keys, "chief_complaint"] };
    docReqs = [{ code: "99344", required_chart_elements: ["chief_complaint"] }];
    await upload(PAY);
    expect(trail()[0]).toBe("Submission confirmed by payer remittance LOCAL-PAY-1");
    for (const a of audits("superbill_status_change")) expect(payloadOf(a)).not.toHaveProperty("documentationGap");
  });
});
