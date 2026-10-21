/**
 * A small SQL evaluator for the team service's specs. It runs the statement
 * the service actually wrote against in-memory tables.
 *
 * Why it exists: the roster spec used to answer every query by searching the
 * text for "FROM org_member" and handing back a fixed list. Adding
 * `HAVING count(up.permission) > 0` to the shipped query brought the bug back
 * (every member with no grants disappears from /team), and the spec still
 * passed 6/6 because the words it searched for were still there. Here LEFT and
 * INNER JOIN, WHERE, GROUP BY, HAVING, the aggregates and ORDER BY behave the
 * way Postgres runs them, so a change to what the query MEANS changes what the
 * spec sees.
 *
 * It fails closed. Any clause, predicate or expression it does not model
 * throws "sql-fake cannot model …" instead of guessing. An unfamiliar rewrite
 * therefore fails with a message saying to extend the fake; it never passes by
 * accident. One caveat: OR and AND stop at the first operand that decides
 * them, so an unmodelled operand is reached only in a case where its value
 * matters. A spec needs a case like that for every branch it depends on.
 *
 * There is no RLS. Each table holds rows for more than one org, which is what
 * a connection that bypasses RLS sees (.env.local notes that the preview
 * deployment connects that way). A statement that relies on RLS to stay inside
 * its org leaks in these specs exactly as it would there.
 *
 * UPDATE is modelled as Postgres runs it: its WHERE picks the rows, every SET
 * expression is evaluated against the row as it was BEFORE the statement, and
 * the count of rows written comes back. now() is the current time.
 *
 * A SELECT may end in FOR UPDATE. Statements here run one at a time, so the
 * lock changes nothing; it is refused where Postgres refuses it (GROUP BY,
 * HAVING, an aggregate, the nullable side of a LEFT JOIN).
 *
 * `a || b` concatenates text, and is NULL when either side is. A searched
 * `CASE WHEN … THEN … [ELSE …] END` takes the first arm whose condition is
 * true; like OR and AND it evaluates only the branch it takes, so an
 * unmodelled branch is reached only in a case that takes it.
 *
 * Deliberately not modelled: subqueries and EXISTS, NOT, BETWEEN, LIKE, the
 * simple `CASE x WHEN …` form and a CASE inside a CASE, casts (they are
 * stripped), functional dependency in GROUP BY, UPDATE … FROM, RETURNING, an
 * UPDATE with no WHERE or one that writes a `unique` column, and every
 * constraint except the one `unique` key a table declares (checked on INSERT
 * only).
 */

export type SqlRow = Record<string, unknown>;

export interface FakeTable {
  columns: readonly string[];
  rows: SqlRow[];
  /** The key ON CONFLICT is judged against, if the table has one. */
  unique?: readonly string[];
}

export type FakeDb = Record<string, FakeTable>;

/** alias → the row it is bound to (null: a LEFT JOIN that matched nothing). */
type Scope = Record<string, SqlRow | null>;

interface Ctx {
  db: FakeDb;
  binds: readonly unknown[];
  /** alias → table name, so a column reference can be checked. */
  aliases: Record<string, string>;
  scope: Scope;
  /** Present while evaluating a grouped row; aggregates need it. */
  group?: Scope[];
}

export class CannotModel extends Error {
  constructor(what: string) {
    super(`sql-fake cannot model ${what} — extend lib/features/team/__tests__/sql-fake.ts`);
  }
}

/**
 * Binds are numbered the way Postgres numbers them. Comments go first, so an
 * apostrophe in a comment cannot open a string. Casts are dropped: the fake
 * holds values that already have the right type.
 */
export function prepare(strings: readonly string[]): string {
  return strings
    .map((s, i) => (i === 0 ? s : `$${i}${s}`))
    .join("")
    .replace(/--[^\n]*/g, " ")
    .replace(/::\w+(\[\])?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Index of the parenthesis closing the one at `open`, skipping string literals. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new CannotModel(`unbalanced parentheses in: ${s}`);
}

/**
 * Split on `sep` wherever it appears outside parentheses and string literals.
 * `sep` is anchored with ^ and tried at every such position.
 */
function splitTop(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0) {
      const m = sep.exec(s.slice(i));
      if (m && m.index === 0) {
        parts.push(s.slice(start, i).trim());
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** `( … )` wrapping the whole of `s` → the inside; otherwise `s`. */
function unwrap(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && closingParen(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
  return t;
}

const CLAUSE = /^(SELECT|FROM|LEFT JOIN|INNER JOIN|RIGHT JOIN|FULL JOIN|CROSS JOIN|JOIN|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|OFFSET|UNION|WINDOW|RETURNING) /i;

/** Top-level clauses of a SELECT, in order. */
function clauses(sql: string): { kw: string; body: string }[] {
  const out: { kw: string; body: string }[] = [];
  let depth = 0;
  let quoted = false;
  let current: { kw: string; start: number } | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (i === 0 || sql[i - 1] === " ")) {
      const m = CLAUSE.exec(sql.slice(i));
      if (m) {
        if (current) out.push({ kw: current.kw, body: sql.slice(current.start, i).trim() });
        current = { kw: m[1]!.toUpperCase(), start: i + m[0].length };
        i += m[0].length - 1;
      }
    }
  }
  if (current) out.push({ kw: current.kw, body: sql.slice(current.start).trim() });
  return out;
}

function table(ctx: Ctx, name: string): FakeTable {
  const t = ctx.db[name];
  if (!t) throw new CannotModel(`table ${name} (the spec did not supply it)`);
  return t;
}

function column(ctx: Ctx, alias: string | null, col: string): unknown {
  const bound = Object.keys(ctx.scope);
  const a = alias ?? (bound.length === 1 ? bound[0]! : null);
  if (a === null) throw new CannotModel(`unqualified column ${col} with ${bound.length} tables in scope`);
  if (!(a in ctx.scope)) throw new CannotModel(`alias ${a} (not in FROM/JOIN)`);
  const t = table(ctx, ctx.aliases[a]!);
  if (!t.columns.includes(col)) {
    throw new CannotModel(`column ${a}.${col}: ${ctx.aliases[a]} has ${t.columns.join(", ")}`);
  }
  const row = ctx.scope[a];
  return row == null ? null : (row[col] ?? null);
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "string" && typeof y === "string") return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === "boolean" && typeof y === "boolean") return Number(x) - Number(y);
  throw new CannotModel(`comparison of ${typeof x} with ${typeof y}`);
}

/** A function call at the top of `expr`: name, argument text, FILTER predicate. */
function call(expr: string): { name: string; args: string; filter: string | null } | null {
  const m = /^(\w+)\s*\(/.exec(expr);
  if (!m) return null;
  const open = m[0].length - 1;
  const close = closingParen(expr, open);
  const rest = expr.slice(close + 1).trim();
  let filter: string | null = null;
  if (rest !== "") {
    const f = /^FILTER \(\s*WHERE /i.exec(rest);
    if (!f || closingParen(rest, rest.indexOf("(")) !== rest.length - 1) return null;
    filter = rest.slice(f[0].length, -1).trim();
  }
  return { name: m[1]!.toLowerCase(), args: expr.slice(open + 1, close).trim(), filter };
}

function aggregateRows(ctx: Ctx, fn: string, filter: string | null): Scope[] {
  if (!ctx.group) throw new CannotModel(`${fn}() outside a grouped query`);
  return filter === null
    ? ctx.group
    : ctx.group.filter((scope) => predicate({ ...ctx, scope, group: undefined }, filter) === true);
}

function scalar(ctx: Ctx, raw: string): unknown {
  const expr = unwrap(raw);
  let m: RegExpExecArray | null;
  if ((m = /^\$(\d+)$/.exec(expr))) {
    const i = Number(m[1]) - 1;
    if (i >= ctx.binds.length) throw new CannotModel(`bind $${i + 1}: only ${ctx.binds.length} values`);
    return ctx.binds[i];
  }
  // Text concatenation (listVisits' `p.first_name || ' ' || p.last_name`).
  const cat = splitTop(expr, /^ \|\| /);
  if (cat.length > 1) {
    const parts = cat.map((p) => scalar(ctx, p));
    if (parts.some((p) => p === null || p === undefined)) return null;
    if (parts.some((p) => typeof p !== "string")) throw new CannotModel(`|| over a non-text value: ${expr}`);
    return parts.join("");
  }
  if ((m = /^CASE (.+) END$/i.exec(expr))) return searchedCase(ctx, m[1]!, expr);
  // '{}' is Postgres's empty-array literal (COALESCE(…, '{}')::text[]).
  if (expr === "'{}'") return [];
  if (/^'(?:[^']|'')*'$/.test(expr)) return expr.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if (/^true$/i.test(expr)) return true;
  if (/^false$/i.test(expr)) return false;
  if (/^null$/i.test(expr)) return null;
  if ((m = /^(\w+)\.(\w+)$/.exec(expr))) return column(ctx, m[1]!, m[2]!);
  if (/^\w+$/.test(expr)) return column(ctx, null, expr);

  const c = call(expr);
  if (!c) throw new CannotModel(`expression: ${expr}`);
  switch (c.name) {
    case "coalesce": {
      if (c.filter) throw new CannotModel(`FILTER on coalesce`);
      for (const arg of splitTop(c.args, /^,/)) {
        const v = scalar(ctx, arg);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    }
    case "count": {
      const rows = aggregateRows(ctx, "count", c.filter);
      if (c.args === "*") return rows.length;
      return rows.filter((scope) => scalar({ ...ctx, scope, group: undefined }, c.args) !== null).length;
    }
    case "array_agg": {
      // Postgres: array_agg over no rows is NULL, not an empty array, and it
      // keeps the NULLs a LEFT JOIN produces unless FILTER removes them.
      const rows = aggregateRows(ctx, "array_agg", c.filter);
      if (rows.length === 0) return null;
      const [valueExpr, orderBy] = splitTop(c.args, /^ ORDER BY /i);
      const items = rows.map((scope) => {
        const inner = { ...ctx, scope, group: undefined };
        return { v: scalar(inner, valueExpr!), k: orderBy ? scalar(inner, orderBy) : null };
      });
      if (orderBy) {
        if (/ (ASC|DESC)$/i.test(orderBy)) throw new CannotModel(`array_agg ORDER BY direction`);
        items.sort((p, q) => nullsLast(p.k, q.k));
      }
      return items.map((it) => it.v);
    }
    case "now": {
      if (c.args !== "" || c.filter) throw new CannotModel(`now(${c.args})`);
      return new Date();
    }
    default:
      throw new CannotModel(`function ${c.name}()`);
  }
}

/**
 * `CASE WHEN c THEN v [WHEN …] [ELSE e] END`, given the text between CASE and
 * END. Only the branch taken is evaluated, as in Postgres.
 */
function searchedCase(ctx: Ctx, body: string, expr: string): unknown {
  // String literals are blanked first, so a 'case' inside one is not a CASE.
  if (/\bCASE\b/i.test(body.replace(/'(?:[^']|'')*'/g, "''"))) throw new CannotModel(`a CASE inside a CASE: ${expr}`);
  const [armsText, otherwise, ...extra] = splitTop(body, /^ ELSE /i);
  if (extra.length > 0) throw new CannotModel(`CASE with more than one ELSE: ${expr}`);
  const [lead, ...arms] = splitTop(` ${armsText}`, /^ WHEN /i);
  if (lead !== "" || arms.length === 0) throw new CannotModel(`the simple CASE form: ${expr}`);
  for (const arm of arms) {
    const [cond, value, ...more] = splitTop(arm, /^ THEN /i);
    if (value === undefined || more.length > 0) throw new CannotModel(`CASE arm: ${arm}`);
    if (predicate(ctx, cond!) === true) return scalar(ctx, value);
  }
  return otherwise === undefined ? null : scalar(ctx, otherwise);
}

function nullsLast(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

/** SQL three-valued logic: true, false, or null for unknown. */
function predicate(ctx: Ctx, raw: string): boolean | null {
  const expr = unwrap(raw);
  const ors = splitTop(expr, /^ OR /i);
  if (ors.length > 1) {
    let unknown = false;
    for (const p of ors) {
      const v = predicate(ctx, p);
      if (v === true) return true;
      if (v === null) unknown = true;
    }
    return unknown ? null : false;
  }
  const ands = splitTop(expr, /^ AND /i);
  if (ands.length > 1) {
    let unknown = false;
    for (const p of ands) {
      const v = predicate(ctx, p);
      if (v === false) return false;
      if (v === null) unknown = true;
    }
    return unknown ? null : true;
  }
  let m: RegExpExecArray | null;
  if ((m = /^(.+) IS (NOT )?NULL$/i.exec(expr))) {
    const isNull = scalar(ctx, m[1]!) === null;
    return m[2] ? !isNull : isNull;
  }
  if ((m = /^(.+?) = ANY\s*\((.+)\)$/i.exec(expr))) {
    const v = scalar(ctx, m[1]!);
    const list = scalar(ctx, m[2]!);
    if (!Array.isArray(list)) throw new CannotModel(`= ANY over a non-array`);
    return v === null ? null : list.includes(v);
  }
  if ((m = /^(.+?) (=|<>|!=|<=|>=|<|>) (.+)$/.exec(expr))) {
    const a = scalar(ctx, m[1]!);
    const b = scalar(ctx, m[3]!);
    if (a === null || b === null) return null;
    const d = m[2] === "=" || m[2] === "<>" || m[2] === "!=" ? (a === b ? 0 : 1) : compare(a, b);
    switch (m[2]) {
      case "=": return d === 0;
      case "<>":
      case "!=": return d !== 0;
      case "<": return d < 0;
      case ">": return d > 0;
      case "<=": return d <= 0;
      default: return d >= 0;
    }
  }
  const v = scalar(ctx, expr);
  if (v === null || typeof v === "boolean") return v;
  throw new CannotModel(`predicate: ${expr}`);
}

function select(db: FakeDb, binds: readonly unknown[], statement: string): SqlRow[] {
  // A row lock has nothing to wait for when statements run one at a time, so
  // a trailing FOR UPDATE is accepted and changes nothing, except where
  // Postgres itself refuses one.
  const lock = / FOR UPDATE$/i.exec(statement);
  const sql = lock ? statement.slice(0, lock.index) : statement;
  const parts = clauses(sql);
  const allowed = new Set(["SELECT", "FROM", "JOIN", "INNER JOIN", "LEFT JOIN", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT"]);
  for (const p of parts) if (!allowed.has(p.kw)) throw new CannotModel(`${p.kw} clause`);
  if (lock) {
    for (const kw of ["GROUP BY", "HAVING", "LEFT JOIN"]) {
      if (parts.some((p) => p.kw === kw)) throw new CannotModel(`FOR UPDATE with ${kw}`);
    }
  }
  const one = (kw: string) => {
    const found = parts.filter((p) => p.kw === kw);
    if (found.length > 1) throw new CannotModel(`more than one ${kw}`);
    return found[0]?.body ?? null;
  };

  const ctx: Ctx = { db, binds, aliases: {}, scope: {} };

  const from = one("FROM");
  const fm = from && /^(\w+)(?: (\w+))?$/.exec(from);
  if (!fm) throw new CannotModel(`FROM ${from ?? "(missing)"}`);
  const fromAlias = fm[2] ?? fm[1]!;
  ctx.aliases[fromAlias] = fm[1]!;
  let scopes: Scope[] = table(ctx, fm[1]!).rows.map((r) => ({ [fromAlias]: r }));

  for (const j of parts.filter((p) => p.kw.endsWith("JOIN"))) {
    const jm = /^(\w+) (\w+) ON (.+)$/i.exec(j.body);
    if (!jm) throw new CannotModel(`${j.kw} ${j.body}`);
    const [, name, alias, on] = jm;
    ctx.aliases[alias!] = name!;
    const rows = table(ctx, name!).rows;
    scopes = scopes.flatMap((scope) => {
      const hits = rows
        .map((r) => ({ ...scope, [alias!]: r }))
        .filter((s) => predicate({ ...ctx, scope: s }, on!) === true);
      if (hits.length > 0) return hits;
      return j.kw === "LEFT JOIN" ? [{ ...scope, [alias!]: null }] : [];
    });
  }

  const where = one("WHERE");
  if (where) scopes = scopes.filter((scope) => predicate({ ...ctx, scope }, where) === true);

  const items = splitTop(one("SELECT") ?? "", /^,/).map((item) => {
    const as = splitTop(item, /^ AS /i);
    if (as.length > 2) throw new CannotModel(`select item ${item}`);
    const expr = as[0]!;
    const name = as[1] ?? /^(?:\w+\.)?(\w+)$/.exec(expr)?.[1];
    if (!name) throw new CannotModel(`unnamed select item ${item}`);
    const aggregate = /\b(array_agg|count|sum|min|max|bool_and|bool_or|string_agg)\s*\(/i.test(expr);
    if (aggregate && lock) throw new CannotModel(`FOR UPDATE with an aggregate`);
    return { expr, name, aggregate };
  });

  const groupBy = one("GROUP BY");
  let groups: Scope[][];
  if (groupBy) {
    const keys = splitTop(groupBy, /^,/);
    for (const it of items) {
      if (!it.aggregate && !keys.includes(it.expr)) {
        throw new CannotModel(
          `${it.expr} selected but not grouped (Postgres allows that only through a grouped primary key)`,
        );
      }
    }
    const byKey = new Map<string, Scope[]>();
    for (const scope of scopes) {
      const key = JSON.stringify(keys.map((k) => scalar({ ...ctx, scope }, k)));
      const g = byKey.get(key);
      if (g) g.push(scope);
      else byKey.set(key, [scope]);
    }
    groups = [...byKey.values()];
  } else if (items.some((it) => it.aggregate)) {
    if (items.some((it) => !it.aggregate)) throw new CannotModel(`mixed aggregate and plain columns without GROUP BY`);
    groups = [scopes];
  } else {
    groups = scopes.map((s) => [s]);
  }

  const having = one("HAVING");
  if (having) {
    if (!groupBy) throw new CannotModel(`HAVING without GROUP BY`);
    groups = groups.filter((g) => predicate({ ...ctx, scope: g[0]!, group: g }, having) === true);
  }

  const orderBy = one("ORDER BY");
  if (orderBy) {
    const keys = splitTop(orderBy, /^,/).map((k) => {
      const km = /^(.+?)(?: (ASC|DESC))?$/i.exec(k)!;
      return { expr: km[1]!, desc: /^DESC$/i.test(km[2] ?? "") };
    });
    const keyed = groups.map((g) => ({
      g,
      k: keys.map((k) => scalar({ ...ctx, scope: g[0] ?? {}, group: g }, k.expr)),
    }));
    // Postgres defaults: NULLS LAST ascending, NULLS FIRST descending.
    keyed.sort((p, q) => {
      for (let i = 0; i < keys.length; i++) {
        const d = nullsLast(p.k[i], q.k[i]);
        if (d !== 0) return keys[i]!.desc ? -d : d;
      }
      return 0;
    });
    groups = keyed.map((x) => x.g);
  }

  const limit = one("LIMIT");
  if (limit !== null) {
    const n = scalar(ctx, limit);
    if (typeof n !== "number") throw new CannotModel(`LIMIT ${limit}`);
    groups = groups.slice(0, n);
  }

  return groups.map((g) => {
    const out: SqlRow = {};
    for (const it of items) out[it.name] = scalar({ ...ctx, scope: g[0] ?? {}, group: g }, it.expr);
    return out;
  });
}

function remove(db: FakeDb, binds: readonly unknown[], sql: string): number {
  const m = /^DELETE FROM (\w+)(?: (\w+))? WHERE (.+)$/i.exec(sql);
  if (!m) throw new CannotModel(`statement: ${sql}`);
  const alias = m[2] ?? m[1]!;
  const ctx: Ctx = { db, binds, aliases: { [alias]: m[1]! }, scope: {} };
  const t = table(ctx, m[1]!);
  const keep = t.rows.filter((r) => predicate({ ...ctx, scope: { [alias]: r } }, m[3]!) !== true);
  const removed = t.rows.length - keep.length;
  t.rows.splice(0, t.rows.length, ...keep);
  return removed;
}

function insert(db: FakeDb, binds: readonly unknown[], sql: string): number {
  const m = /^INSERT INTO (\w+) \(([^()]*)\) VALUES \((.*)\)( ON CONFLICT DO NOTHING)?$/i.exec(sql);
  if (!m) throw new CannotModel(`statement: ${sql}`);
  const ctx: Ctx = { db, binds, aliases: {}, scope: {} };
  const t = table(ctx, m[1]!);
  const cols = m[2]!.split(",").map((c) => c.trim());
  const vals = splitTop(m[3]!, /^,/);
  if (cols.length !== vals.length) throw new CannotModel(`INSERT with ${cols.length} columns and ${vals.length} values`);
  const row: SqlRow = Object.fromEntries(t.columns.map((c) => [c, null]));
  cols.forEach((c, i) => {
    if (!t.columns.includes(c)) throw new CannotModel(`column ${m[1]}.${c}`);
    row[c] = scalar(ctx, vals[i]!);
  });
  const clash =
    t.unique && t.rows.some((r) => t.unique!.every((k) => r[k] !== null && r[k] === row[k]));
  if (clash) {
    if (m[4]) return 0;
    throw new Error(`duplicate key on ${m[1]} (${t.unique!.join(", ")})`);
  }
  t.rows.push(row);
  return 1;
}

/**
 * UPDATE t [alias] SET col = expr, … WHERE …. The WHERE and the SET list are
 * split at the top level only, so a parenthesised subquery is refused by the
 * expression it sits in rather than cutting the statement in the wrong place.
 */
function update(db: FakeDb, binds: readonly unknown[], sql: string): number {
  const m = /^UPDATE (\w+)(?: (\w+))? SET (.+)$/i.exec(sql);
  if (!m || /^SET$/i.test(m[2] ?? "")) throw new CannotModel(`statement: ${sql}`);
  const alias = m[2] ?? m[1]!;
  const ctx: Ctx = { db, binds, aliases: { [alias]: m[1]! }, scope: {} };
  const t = table(ctx, m[1]!);
  for (const kw of [" RETURNING ", " FROM "]) {
    if (splitTop(m[3]!, new RegExp(`^${kw}`, "i")).length > 1) throw new CannotModel(`UPDATE …${kw.trimEnd()}`);
  }
  const [setList, where, ...extra] = splitTop(m[3]!, /^ WHERE /i);
  if (where === undefined) throw new CannotModel(`UPDATE without WHERE`);
  if (extra.length > 0) throw new CannotModel(`more than one WHERE in: ${sql}`);
  const sets = splitTop(setList!, /^,/).map((part) => {
    const s = /^(\w+) = (.+)$/.exec(part);
    if (!s) throw new CannotModel(`SET item ${part}`);
    if (!t.columns.includes(s[1]!)) throw new CannotModel(`column ${m[1]}.${s[1]}`);
    if (t.unique?.includes(s[1]!)) throw new CannotModel(`UPDATE of the unique column ${s[1]}`);
    return { col: s[1]!, expr: s[2]! };
  });
  let n = 0;
  for (const row of t.rows) {
    const scope = { [alias]: row };
    if (predicate({ ...ctx, scope }, where) !== true) continue;
    // Every value from the row as it was, then all written at once.
    const values = sets.map((s) => scalar({ ...ctx, scope }, s.expr));
    sets.forEach((s, i) => {
      row[s.col] = values[i];
    });
    n++;
  }
  return n;
}

/** Run one statement. SELECT returns rows; DELETE, INSERT and UPDATE return a count. */
export function run(db: FakeDb, strings: readonly string[], binds: readonly unknown[]): SqlRow[] | number {
  const sql = prepare(strings);
  if (/^SELECT /i.test(sql)) return select(db, binds, sql);
  if (/^DELETE /i.test(sql)) return remove(db, binds, sql);
  if (/^INSERT /i.test(sql)) return insert(db, binds, sql);
  if (/^UPDATE /i.test(sql)) return update(db, binds, sql);
  throw new CannotModel(`statement: ${sql}`);
}

/**
 * A stand-in for the Prisma transaction client withOrgContext hands a
 * service. Every statement is appended to `log` (normalised) so a spec can
 * also prove that something did NOT run.
 */
export function fakeTx(db: FakeDb, log: string[] = []) {
  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    log.push(prepare(strings));
    try {
      return Promise.resolve(run(db, strings, values));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  return {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => exec(strings, ...values),
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      exec(strings, ...values).then((r) => (typeof r === "number" ? r : r.length)),
  };
}
