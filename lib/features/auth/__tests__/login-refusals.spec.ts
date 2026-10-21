/**
 * The login and signup refusals migration 0101 (audit R36) relies on, plus the
 * scoping of the permission array the session is built from.
 *
 * 0101 retires 'Pallio Live Demo' by setting org.deleted_at and suspending
 * livedemo@pallio.io. It claims three things about the code, pinned here:
 *   1. a suspended user is refused, even with the right password;
 *   2. a user whose only seat is in a retired org is refused;
 *   3. signup refuses the retired org's name (the slug check ignores
 *      deleted_at) and an email already on file.
 * The real login()/signup() run against a mocked database; nothing signs in.
 *
 * Two more refusals on the same password path are pinned here because nothing
 * else in the app repeats them:
 *   - the MFA gate. login() is the ONLY place an enrolled account is asked for
 *     a code; no middleware re-checks it. Until these tests, every case
 *     answered the enrolment probe with NULL, so the gate was never entered
 *     and deleting it whole left the suite green. The probe is answered from
 *     a two-row app_user here rather than with a canned value, so it also has
 *     to stay scoped to the account signing in.
 *   - the suspended org. The org lookup filters o.deleted_at but not o.status,
 *     so the org_status comparison in login() is the only thing standing
 *     between a member of a suspended (not deleted) org and a valid session.
 *   - the permission read's org scope. It used to be answered here with a
 *     canned [{ permission: 'patients.view' }] whatever statement arrived, so
 *     no test in this file could see which ids the query bound. It is answered
 *     from a two-org user_permission table now, by running login()'s own
 *     statement through the repo's SQL evaluator, which is what turns the
 *     CONTROL's permissions assertion into a real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  compare: vi.fn(),
  verifyMfa: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: h.queryRaw, $executeRaw: h.executeRaw, $transaction: h.transaction },
  withOrgContext: vi.fn(),
  withBreakglass: vi.fn(),
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed"), compare: h.compare },
}));
vi.mock("@/lib/features/auth/password-policy", () => ({
  checkPassword: () => ({ ok: true }),
}));
// login() reaches the verifier through a dynamic import("./mfa.service"), which
// resolves to this same module, so the stub stands in for the real TOTP check.
vi.mock("../mfa.service", () => ({ verifyMfaChallenge: h.verifyMfa }));

import { withBreakglass, withOrgContext } from "@/lib/db";
import { fakeTx, type FakeDb } from "@/lib/features/team/__tests__/sql-fake";

import { login, signup } from "../auth.service";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
/** The user's SECOND seat. Two orgs per user is an ordinary product flow:
 *  invite-redeem reuses the app_user row when the address is already on file. */
const ORG_B = "22222222-2222-4222-8222-222222222222";
/** Another account, which HAS enrolled, sitting ahead of this one in app_user. */
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ENROLLED = new Date("2026-01-02T09:00:00Z");

/**
 * user_permission as the rows it actually holds, for two orgs and two users.
 * The permission read is answered by RUNNING login()'s own statement against
 * these rows (see the withOrgContext mock below), so the statement is what
 * decides.
 */
const GRANTS = [
  { org_id: ORG, user_id: USER, permission: "patients.view" },
  { org_id: ORG_B, user_id: USER, permission: "team.permissions" },
  { org_id: ORG, user_id: OTHER_USER, permission: "billing.superbills.void" },
];

/** The app_user row login() reads, and the seat the org lookup returns. */
let user: { id: string; email: string; password_hash: string | null; status: string; is_platform_admin: boolean } | null;
let seats: { org_id: string; role: string; role_template: string | null; org_status: string }[];
/** app_user.mfa_enrolled_at — non-null is an account that has enrolled. */
let mfaEnrolledAt: Date | null;
/** What signup's uniqueness checks find. */
let emailTaken: boolean;
let slugTaken: boolean;
let calls: string[] = [];
let orgLookupSql = "";
/** GRANTS as a table the permission statement is executed against. */
let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  orgLookupSql = "";
  db = {
    user_permission: {
      columns: ["org_id", "user_id", "permission"],
      rows: GRANTS.map((g) => ({ ...g })),
    },
  };
  user = { id: USER, email: "livedemo@pallio.io", password_hash: "$2a$12$hash", status: "active", is_platform_admin: false };
  seats = [{ org_id: ORG, role: "admin", role_template: "org_admin", org_status: "active" }];
  emailTaken = false;
  slugTaken = false;
  mfaEnrolledAt = null;
  h.compare.mockResolvedValue(true);
  h.verifyMfa.mockResolvedValue(true);
  h.executeRaw.mockResolvedValue(1);
  h.queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push(sql);
    if (sql.includes("SELECT id, email, password_hash, status")) return Promise.resolve(user ? [user] : []);
    if (sql.includes("SELECT mfa_enrolled_at")) return Promise.resolve(mfaProbe(values));
    if (sql.includes("FROM app_user WHERE email")) return Promise.resolve(emailTaken ? [{ id: USER }] : []);
    if (sql.includes("FROM org WHERE slug")) return Promise.resolve(slugTaken ? [{ id: ORG }] : []);
    if (sql.includes("gen_random_uuid")) return Promise.resolve([{ id: ORG }]);
    return Promise.resolve([]);
  });
  vi.mocked(withBreakglass).mockImplementation((async (fn: (c: unknown) => Promise<unknown>) =>
    fn({
      $queryRaw: (strings: TemplateStringsArray) => {
        orgLookupSql = strings.join("¶");
        return Promise.resolve(seats);
      },
    })) as never);
  // The permission read is EXECUTED, not pattern-matched: sql-fake parses the
  // statement login() sent and evaluates its clauses against `db`.
  //
  // The fake this replaced reduced the statement to the SET of values it
  // bound, and asked only whether a row's ids were among them. AND/OR, = vs
  // <>, and which column a value landed in were therefore all invisible:
  // rewriting `AND org_id` to `OR org_id` — which hands the session the user's
  // grants in EVERY org PLUS every other member's grants in this one, strictly
  // worse than the missing-predicate bug this file was written to catch — kept
  // all 16 tests green, as did negating the org predicate and swapping the two
  // binds into each other's columns. sql-fake also fails closed: a rewrite it
  // cannot model throws rather than passing.
  //
  // There is no RLS in the evaluator, which is the connection being modelled
  // on purpose: .env.local notes the preview deployment connects as a
  // superuser, and a superuser bypasses RLS on every table regardless of
  // FORCE, so app.current_org_id bounds nothing there and the query's own
  // predicates are the only filter left. A statement that binds only the user
  // id therefore gets that user's grants in EVERY org — the live database
  // returns 8 for multi@example.test that way, against 4 with the org
  // predicate.
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx(db)),
  );
});

/**
 * app_user as the enrolment probe reads it, rather than one canned answer:
 * an account that HAS enrolled sits ahead of the one signing in, and a row
 * comes back only if the query bound its id. A probe that binds nothing is an
 * unfiltered scan and takes OTHER_USER off the top; one that binds the wrong
 * id matches no row at all. Either way the gate stops being about the account
 * whose password was just checked — it challenges users who never set MFA up,
 * or waves an enrolled one straight through.
 */
function mfaProbe(values: unknown[]): { mfa_enrolled_at: Date | null }[] {
  const table = [
    { id: OTHER_USER, mfa_enrolled_at: OTHER_ENROLLED },
    { id: USER, mfa_enrolled_at: mfaEnrolledAt },
  ];
  const rows = values.length === 0 ? table : table.filter((r) => values.includes(r.id));
  return rows.slice(0, 1).map((r) => ({ mfa_enrolled_at: r.mfa_enrolled_at }));
}

const signIn = (mfaCode?: string) =>
  login({ email: "livedemo@pallio.io", password: "the-right-one", mfaCode });

describe("login — refusals 0101 relies on", () => {
  it("refuses a suspended user even with the right password", async () => {
    user!.status = "suspended";
    expect(await signIn()).toEqual({ error: "user_inactive" });
    // Refused before any org is resolved or a session is built.
    expect(withBreakglass).not.toHaveBeenCalled();
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("refuses a user whose only seat is in a retired org", async () => {
    seats = []; // the org lookup excludes deleted orgs, so a retired org's seat matches nothing
    expect(await signIn()).toEqual({ error: "user_inactive" });
    expect(orgLookupSql).toContain("o.deleted_at IS NULL");
    expect(orgLookupSql).toContain("m.status = 'active'");
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("refuses a member of a suspended org, which the org lookup itself lets through", async () => {
    // 0101 retires an org by setting deleted_at, but an org can also be
    // suspended without being deleted (billing lapsed, BAA withdrawn). The
    // lookup only excludes deleted orgs, so the seat still comes back and the
    // org_status comparison is what refuses it.
    seats = [{ org_id: ORG, role: "admin", role_template: "org_admin", org_status: "suspended" }];
    expect(await signIn()).toEqual({ error: "user_inactive" });
    expect(withOrgContext).not.toHaveBeenCalled();
    expect(h.executeRaw).not.toHaveBeenCalled(); // no last_login_at stamp either
    // Why the comparison carries the whole refusal: nothing in the SQL does.
    expect(orgLookupSql).toContain("o.status AS org_status");
    expect(orgLookupSql).not.toMatch(/o\.status\s*=/);

    // CONTROL — the same seat in an active org is the session it was refused.
    seats = [{ ...seats[0]!, org_status: "active" }];
    expect("session" in (await signIn())).toBe(true);
  });

  it("refuses a wrong password as invalid credentials, before looking at status or org", async () => {
    h.compare.mockResolvedValue(false);
    user!.status = "suspended";
    expect(await signIn()).toEqual({ error: "invalid_credentials" });
    expect(withBreakglass).not.toHaveBeenCalled();
  });

  it("CONTROL — an active user in a live org gets a session", async () => {
    const r = await signIn();
    expect("session" in r).toBe(true);
    if ("session" in r) {
      expect(r.session.orgId).toBe(ORG);
      expect(r.session.permissions).toEqual(["patients.view"]);
    }
  });
});

describe("login — the session's permission array is bounded to one org", () => {
  it("carries the grants held in the org signed into, and not the user's other org", async () => {
    // requireAuth() gates every route on session.permissions alone, so this
    // array IS the user's authority until the token expires. USER holds
    // team.permissions in ORG_B — the right to hand out permissions — and
    // signs in to ORG, where they hold only patients.view. Without the org
    // predicate the statement binds the user and nothing else, and on the
    // RLS-bypassing connection .env.local describes that is a session for ORG
    // carrying ORG_B's grant: the tenant boundary crossed by the one query
    // that mints the session.
    const r = await signIn();
    expect("session" in r).toBe(true);
    if (!("session" in r)) return;
    expect(r.session.orgId).toBe(ORG);
    expect(r.session.permissions).toEqual(["patients.view"]);
    expect(r.session.permissions).not.toContain("team.permissions");
    // The read runs under the org that was resolved, not some other one.
    expect(withOrgContext).toHaveBeenCalledWith(ORG, expect.any(Function));
  });

  it("CONTROL — the same user signing into the other org gets that org's grant", async () => {
    // Without this the query could bind a constant org id, or drop the user's
    // grants altogether, and the assertion above would still read as scoping.
    seats = [{ org_id: ORG_B, role: "admin", role_template: "org_admin", org_status: "active" }];
    const r = await signIn();
    expect("session" in r).toBe(true);
    if (!("session" in r)) return;
    expect(r.session.orgId).toBe(ORG_B);
    expect(r.session.permissions).toEqual(["team.permissions"]);
  });

  it("CONTROL — never another member's grants, whichever org it runs under", async () => {
    // OTHER_USER holds billing.superbills.void in the very org being signed
    // into. A read that lost the user binding would hand it over.
    const r = await signIn();
    if (!("session" in r)) throw new Error("expected a session");
    expect(r.session.permissions).not.toContain("billing.superbills.void");
  });
});

describe("login — the MFA gate", () => {
  const ENROLLED = new Date("2026-05-04T09:00:00Z");

  it("refuses an enrolled account that supplies no code, and builds no session", async () => {
    mfaEnrolledAt = ENROLLED;
    // /api/auth/login answers this one 401 "MFA code required." and sends the
    // browser to the code prompt.
    expect(await signIn()).toEqual({ error: "mfa_required" });
    expect(h.verifyMfa).not.toHaveBeenCalled();
    expect(withBreakglass).not.toHaveBeenCalled();
    expect(withOrgContext).not.toHaveBeenCalled();
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it("refuses a code the verifier rejects, with its own error, and builds no session", async () => {
    mfaEnrolledAt = ENROLLED;
    h.verifyMfa.mockResolvedValue(false);
    // A separate error from mfa_required: the route answers it 401 "MFA code
    // didn't match.", so a stale code reads differently from a missing one.
    expect(await signIn("000000")).toEqual({ error: "mfa_bad_code" });
    expect(h.verifyMfa).toHaveBeenCalledWith({ userId: USER, code: "000000" });
    expect(withBreakglass).not.toHaveBeenCalled();
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("CONTROL — an enrolled account with a code the verifier accepts gets its session", async () => {
    // Without this the gate could be inverted (refuse the good code, pass the
    // bad one) and the two refusals above would still read as enforcement.
    mfaEnrolledAt = ENROLLED;
    const r = await signIn("123456");
    expect("session" in r).toBe(true);
    if ("session" in r) expect(r.session.userId).toBe(USER);
    expect(h.verifyMfa).toHaveBeenCalledWith({ userId: USER, code: "123456" });
  });

  it("never challenges an account that has not enrolled, even if a code is sent", async () => {
    // The gate hangs on mfa_enrolled_at alone. Challenging everyone would lock
    // out every account that never set MFA up.
    const r = await signIn("000000");
    expect("session" in r).toBe(true);
    expect(h.verifyMfa).not.toHaveBeenCalled();
  });

  it("asks whether THIS account has enrolled, not whichever account has", async () => {
    // The probe must filter on the user whose password was just verified. It
    // reads app_user, which holds every tenant's accounts: unscoped, its first
    // row answers for everyone, and one enrolled account anywhere in the table
    // turns the gate into either a lockout or a bypass. mfaProbe above answers
    // as the table would, so this is decided by the query, not by the fake.
    mfaEnrolledAt = null; // this user never enrolled; OTHER_USER did
    const r = await signIn();
    expect("session" in r).toBe(true);
    expect(h.verifyMfa).not.toHaveBeenCalled();
    // The binding itself, in the query that was actually sent — the same way
    // the org lookup's scoping is pinned above.
    const probe = calls.find((s) => s.includes("SELECT mfa_enrolled_at"))!;
    expect(probe).toContain("WHERE id = ");
  });
});

describe("signup — refusals 0101 relies on", () => {
  const signUp = (email = "someone.new@example.test", orgName = "Pallio Live Demo") =>
    signup({ email, password: "not-checked-here", fullName: "New Person", orgName, baaAccepted: true });

  it("refuses an email already on file, and creates nothing", async () => {
    emailTaken = true;
    expect(await signUp("livedemo@pallio.io")).toEqual({ error: "email_taken" });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("refuses a retired org's name: the slug check does not look at deleted_at", async () => {
    slugTaken = true;
    expect(await signUp()).toEqual({ error: "org_name_taken" });
    const slugSql = calls.find((s) => s.includes("FROM org WHERE slug"))!;
    expect(slugSql).not.toContain("deleted_at");
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("checks the email before the org name", async () => {
    emailTaken = true;
    slugTaken = true;
    expect(await signUp("livedemo@pallio.io")).toEqual({ error: "email_taken" });
  });
});
