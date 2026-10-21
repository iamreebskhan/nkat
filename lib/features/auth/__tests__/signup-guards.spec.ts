/**
 * The two refusals that stand between a public form and a live org holding PHI.
 *
 * POST /api/auth/signup is unauthenticated and there is no middleware.ts, so
 * signup() is the server. Two of its branches had no test at all:
 *
 *   1. THE PASSWORD POLICY. The route schema only enforces min(12), so a
 *      twelve-character weak password ("aaaaaaaaaaaa", the signer's own email)
 *      reaches the service and `if (!strength.ok)` is the only thing that
 *      refuses it. The other two auth specs replace the policy module outright
 *      with `checkPassword: () => ({ ok: true })`, so neither can tell whether
 *      signup calls it, with what, or what it does with the answer. This spec
 *      deliberately does NOT mock @/lib/features/auth/password-policy — the
 *      real rules run, and the reasons asserted are the policy's own.
 *
 *   2. THE BAA REFUSAL. org.baa_signed_at is the only record anywhere that a
 *      customer accepted the Business Associate Agreement: no acceptance
 *      table, no audit row, nothing to contradict it. An auditor reads that
 *      timestamp as the signature. So the test is not only that a declined
 *      signup is refused, but that the column is written FROM the acceptance —
 *      it used to be an unconditional now(), which meant losing the refusal
 *      would have stamped a HIPAA signature date on a customer who declined.
 *
 * prisma is mocked; the transaction runs against a fake tx that records each
 * statement with its bind positions intact, so the assertions below are about
 * the statement signup actually sends and the values it actually binds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), transaction: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: h.queryRaw, $transaction: h.transaction },
  withOrgContext: vi.fn(),
  withBreakglass: vi.fn(),
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed"), compare: vi.fn() },
}));

import { signup } from "../auth.service";
import { checkPassword } from "../password-policy";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const EMAIL = "owner@riverside-pall.test";
const ORG_NAME = "Riverside Palliative";
const FULL_NAME = "Practice Owner";
/** Long, unguessable, and none of the identifiers above. The real policy passes it. */
const GOOD_PASSWORD = "quiet-harbor-lantern-49";

/** Each statement the transaction ran: the SQL with $n where a value was bound. */
let statements: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    // $n markers, so a column's VALUES entry can be told apart from a literal.
    const sql = strings.reduce((acc, part, i) => acc + (i ? `$${i}` : "") + part, "");
    statements.push({ sql, values });
    if (sql.includes("INSERT INTO app_user")) return Promise.resolve([{ id: USER }]);
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  vi.clearAllMocks();
  statements = [];
  h.queryRaw.mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve(strings.join("¶").includes("gen_random_uuid") ? [{ id: ORG }] : []),
  );
  h.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx()));
});

const signUp = (over: Partial<Parameters<typeof signup>[0]> = {}) =>
  signup({
    email: EMAIL,
    password: GOOD_PASSWORD,
    fullName: FULL_NAME,
    orgName: ORG_NAME,
    baaAccepted: true,
    ...over,
  });

/**
 * The branch of a column expression that would actually be written, given a
 * value for its condition. A plain expression resolves to itself; `CASE WHEN
 * $n THEN a ELSE b END` resolves to a or b.
 *
 * This EVALUATES the expression the service sent instead of searching it for
 * words, because searching cannot tell a conditional apart from its inverse:
 * `CASE WHEN $n::boolean THEN NULL ELSE now() END` binds the acceptance and
 * contains now(), so it satisfies both of the assertions below while writing
 * baa_signed_at = NULL for every customer who DID accept — no signature at all
 * in the only column that records one.
 */
function branchTaken(expr: string, condition: unknown): string {
  const m = /^CASE WHEN \$\d+(?:::\w+)? THEN ([\s\S]+?) ELSE ([\s\S]+?) END$/.exec(expr);
  if (!m) return expr;
  if (typeof condition !== "boolean") {
    throw new Error(`the CASE condition bound ${JSON.stringify(condition)}, not a boolean: ${expr}`);
  }
  return (condition ? m[1]! : m[2]!).trim();
}

/**
 * What a named column of the org INSERT is actually set to: the expression as
 * sent, every value bound inside it, and the branch that value selects. Read
 * out of the statement rather than assumed from the column order, so
 * reordering the INSERT does not quietly point this at the wrong column.
 */
function orgInsertColumn(name: string): { expr: string; binds: unknown[]; resolved: string } {
  const stmt = statements.find((s) => s.sql.includes("INSERT INTO org ("));
  if (!stmt) throw new Error("signup ran no INSERT INTO org");
  const m = stmt.sql.match(/INSERT INTO org \(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)/);
  if (!m) throw new Error(`could not read the org INSERT: ${stmt.sql}`);
  const columns = m[1]!.split(",").map((c) => c.trim());
  const exprs = splitTopLevel(m[2]!);
  const at = columns.indexOf(name);
  if (at < 0) throw new Error(`the org INSERT no longer writes ${name}`);
  if (exprs.length !== columns.length) {
    throw new Error(`${columns.length} columns but ${exprs.length} values`);
  }
  const expr = exprs[at]!;
  const binds = [...expr.matchAll(/\$(\d+)/g)].map((p) => stmt.values[Number(p[1]) - 1]);
  // Resolved against the value the service itself bound into the condition,
  // not one this spec chose.
  const cond = /^CASE WHEN \$(\d+)/.exec(expr);
  const resolved = cond ? branchTaken(expr, stmt.values[Number(cond[1]) - 1]) : expr;
  return { expr, binds, resolved };
}

/** Split a VALUES list on its own commas, ignoring any inside parentheses. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

describe("signup — the BAA refusal", () => {
  it("refuses a signup that declined the BAA, and creates nothing at all", async () => {
    expect(await signUp({ baaAccepted: false })).toEqual({ error: "baa_required" });
    // Not "it threw somewhere later": no transaction was opened, so no org,
    // no admin user, no permission rows, no session.
    expect(h.transaction).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });

  it("writes baa_signed_at from the acceptance, not from a constant", async () => {
    await signUp({ baaAccepted: true });
    const baa = orgInsertColumn("baa_signed_at");
    // The acceptance itself is bound into the column's expression. An
    // unconditional now() binds nothing there and would stamp a signature date
    // on a customer who declined the moment the refusal above is ever lost;
    // a literal NULL binds nothing either and would stop recording the real
    // acceptances this column exists to evidence.
    expect(baa.binds).toEqual([true]);
    // And the expression resolves — under the value just asserted — to the
    // clock, not merely mentions it somewhere. `CASE WHEN $n THEN NULL ELSE
    // now() END` binds true and contains now() too, and records no signature
    // for anyone who accepted.
    expect(baa.resolved).toBe("now()");
    // The other branch is the one a declined signup would take if it ever
    // reached this INSERT: it must leave the column empty rather than fabricate
    // a signature date. Two now() branches would read as conditional and stamp
    // everyone.
    expect(branchTaken(baa.expr, false)).toBe("NULL");
  });

  it("CONTROL — the columns that are meant to be constants still are", async () => {
    // Otherwise "carries a bind" could be satisfied by binding everything, and
    // the assertion above would stop being about the BAA.
    await signUp({ baaAccepted: true });
    expect(orgInsertColumn("status")).toEqual({ expr: "'active'", binds: [], resolved: "'active'" });
    expect(orgInsertColumn("plan_tier")).toEqual({ expr: "'solo'", binds: [], resolved: "'solo'" });
    // And the org is still created with the caller's own details.
    expect(orgInsertColumn("name").binds).toEqual([ORG_NAME]);
  });
});

describe("signup — the password policy, run for real", () => {
  // Each of these is 12+ characters, so the route schema's min(12) lets it
  // through and the service's own check is the only refusal left.
  const weak: [label: string, password: string][] = [
    ["twelve identical characters", "aaaaaaaaaaaa"],
    ["the signer's own email address", EMAIL],
    ["a straight alphabetical run", "abcdefghijklm"],
    // Not a repeated unit and not a run, so it is the all-digits rule that
    // refuses it and not one of the patterns above.
    ["all digits — a date, a phone number or a PIN", "195024081973"],
    ["a padded common base", "passwordpassword"],
  ];

  for (const [label, password] of weak) {
    it(`refuses ${label}, with the policy's own reason, and creates nothing`, async () => {
      const verdict = checkPassword(password, {
        email: EMAIL,
        orgName: ORG_NAME,
        fullName: FULL_NAME,
      });
      // Sanity: the fixture is one the real policy actually refuses.
      expect(verdict.ok).toBe(false);
      const reason = verdict.ok ? undefined : verdict.reason;

      // The reason is the policy's, not a generic line — the route prefers it
      // over "Password must be at least 12 characters.", which would be a lie
      // about a 16-character password. Comparing to the policy's own output
      // also pins that signup passes email/orgName/fullName through: drop that
      // context and the email case below is accepted outright.
      expect(await signUp({ password })).toEqual({ error: "weak_password", reason });
      expect(h.transaction).not.toHaveBeenCalled();
      expect(statements.some((s) => s.sql.includes("INSERT INTO app_user"))).toBe(false);
    });
  }

  it("CONTROL — a strong password is accepted and the org is created", async () => {
    // Without this the refusals above would be satisfied by a signup that
    // refuses everything.
    const r = await signUp();
    expect("session" in r).toBe(true);
    expect(statements.some((s) => s.sql.includes("INSERT INTO app_user"))).toBe(true);
  });

  it("checks the password before touching the database at all", async () => {
    // A weak password must not cost an email-uniqueness read, a slug read or a
    // bcrypt hash — signup is a public unauthenticated endpoint.
    await signUp({ password: "aaaaaaaaaaaa" });
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});
