/**
 * POST /api/cron/payer-rule-alerts — which practices get a digest, and from
 * which day their window starts.
 *
 * Two defects, one behind the other:
 *
 *   - The cron listed its orgs through the tenant client with no org GUC. org
 *     and org_rulebook are FORCE RLS on app.current_org_id(), so as the app
 *     role (what DATABASE_URL is in prod, and locally) the listing came back
 *     empty: no practice was ever dispatched, and the job still answered 200.
 *     The other cross-tenant crons (the calendar pull, denial feedback) read
 *     through withBreakglass; this one now does too.
 *
 *   - The window's first day was `${since}::date` with `since` a JS Date. A
 *     Date is bound as a timestamptz, and timestamptz::date is its day in the
 *     database SESSION's zone, not the practice's. A check at 9 pm EST on
 *     1 Mar is already 2 Mar in a UTC or Asia/Karachi session, so a rule
 *     effective on 1 Mar was not reported to a practice in New York. The first
 *     day is now the practice's own day of the checkpoint (or a week before its
 *     today), bound as a 'YYYY-MM-DD' string.
 *
 * The fake database below holds ROWS and answers each statement as a Postgres
 * session in the zone under test would: a Date bound into ::date is its
 * calendar day in that session zone, a 'YYYY-MM-DD' string is itself (and one
 * that is not a real day is refused, as Postgres refuses it). The tenant
 * client models RLS: with no GUC it sees no org, and inside withOrgContext
 * every table answers for the GUC's org only. The admin client (breakglass)
 * bypasses RLS. So does the transaction in the RLS-off variant (a superuser
 * connection, as on the preview deployment): there each statement is bounded
 * by its own predicates alone. A statement the fake does not model throws,
 * rather than being answered.
 */
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ tenantQueryRaw: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: h.tenantQueryRaw, $executeRaw: h.tenantQueryRaw },
  withOrgContext: vi.fn(),
  withBreakglass: vi.fn(),
}));
vi.mock("@/lib/email/email.service", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: () => ({ APP_BASE_URL: "http://localhost:3000" }) }));

import { POST } from "@/app/api/cron/payer-rule-alerts/route";
import { withBreakglass, withOrgContext } from "@/lib/db";
import { sendEmail } from "@/lib/email/email.service";
import { dispatchPayerRuleAlerts } from "@/lib/features/alerts/payer-rule-alerts.service";

const ORG_NY = "11111111-1111-4111-8111-111111111111";
const ORG_LA = "22222222-2222-4222-8222-222222222222";
const ORG_NO_BOOK = "33333333-3333-4333-8333-333333333333";
const ORG_SUSP = "44444444-4444-4444-8444-444444444444";
const PAYER = "a0000000-0000-4000-8000-000000000301";
const U_NY = "b0000000-0000-4000-8000-0000000000a1";
const U_NY_FORMER = "b0000000-0000-4000-8000-0000000000a2";
const U_NY_NURSE = "b0000000-0000-4000-8000-0000000000a3";
const U_LA = "b0000000-0000-4000-8000-0000000000b1";
const U_SUSP = "b0000000-0000-4000-8000-0000000000c1";

const NY_ADMIN = "ny-admin@riverside.test";
const LA_ADMIN = "la-admin@pacific.test";

/** 1 Mar's two Ohio rules, in one digest. */
const TWO_CHANGES = "Anthem BCBS Ohio (Elevance) (OH) — 2 rule changes";

/** A DATE column as Prisma returns it: the day at UTC midnight. */
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const ORGS = [
  { id: ORG_NY, name: "Riverside Palliative", timezone: "America/New_York", status: "active" },
  { id: ORG_LA, name: "Pacific Palliative", timezone: "America/Los_Angeles", status: "active" },
  { id: ORG_NO_BOOK, name: "No Rulebook Hospice", timezone: "America/Chicago", status: "active" },
  { id: ORG_SUSP, name: "Suspended Hospice", timezone: "America/New_York", status: "suspended" },
];

/** One rulebook per org (UNIQUE (org_id), 0031); none for ORG_NO_BOOK. */
const RULEBOOKS = [{ org_id: ORG_NY }, { org_id: ORG_LA }, { org_id: ORG_SUSP }];

/** Several rows per (payer, state), as on the dev database: EXISTS counts each rule once. */
const RULEBOOK_ROWS = [
  { org_id: ORG_NY, payer_id: PAYER, state: "OH", cpt_code: "99347" },
  { org_id: ORG_NY, payer_id: PAYER, state: "OH", cpt_code: "99348" },
  { org_id: ORG_NY, payer_id: PAYER, state: "OH", cpt_code: "99349" },
  { org_id: ORG_LA, payer_id: PAYER, state: "OH", cpt_code: "99347" },
  { org_id: ORG_SUSP, payer_id: PAYER, state: "OH", cpt_code: "99347" },
];

const PAYERS = [{ id: PAYER, name: "Anthem BCBS Ohio (Elevance)" }];

/** 28 Feb's rule is one day early; the NC rule is outside every rulebook. */
const PAYER_RULES = [
  { payer_id: PAYER, state: "OH", effective_date: day("2026-02-28") },
  { payer_id: PAYER, state: "OH", effective_date: day("2026-03-01") },
  { payer_id: PAYER, state: "OH", effective_date: day("2026-03-01") },
  { payer_id: PAYER, state: "NC", effective_date: day("2026-03-01") },
];

const USERS = [
  { id: U_NY, email: NY_ADMIN, status: "active" },
  { id: U_NY_FORMER, email: "ny-former-admin@riverside.test", status: "suspended" },
  { id: U_NY_NURSE, email: "ny-nurse@riverside.test", status: "active" },
  { id: U_LA, email: LA_ADMIN, status: "active" },
  { id: U_SUSP, email: "admin@suspended-hospice.test", status: "active" },
];

/** Only an active team.permissions holder is a recipient. */
const PERMISSIONS = [
  { org_id: ORG_NY, user_id: U_NY, permission: "team.view" },
  { org_id: ORG_NY, user_id: U_NY, permission: "team.permissions" },
  { org_id: ORG_NY, user_id: U_NY_FORMER, permission: "team.permissions" },
  { org_id: ORG_NY, user_id: U_NY_NURSE, permission: "visits.submit" },
  { org_id: ORG_LA, user_id: U_LA, permission: "team.permissions" },
  { org_id: ORG_SUSP, user_id: U_SUSP, permission: "team.permissions" },
];

/** org_rule_alert_checkpoint: org_id -> last_checked_at. */
let checkpoints: Map<string, Date>;

/** The calendar day of an instant in a zone, as Postgres computes it. */
function pgDay(at: Date, zone: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const part = (t: string) => p.find((x) => x.type === t)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** What `bind::date` is in a session whose TimeZone is `sessionZone`. */
function asDate(bind: unknown, sessionZone: string): string {
  if (bind instanceof Date) return pgDay(bind, sessionZone);
  if (typeof bind === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bind)) {
    // Postgres refuses a day that does not exist (SQLSTATE 22008).
    const t = Date.parse(`${bind}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== bind) {
      throw new Error(`date/time field value out of range: "${bind}"`);
    }
    return bind;
  }
  throw new Error(`the fake cannot cast ${String(bind)} to a date`);
}

/** The statement as the database sees it, binds numbered in place. */
const numbered = (strings: TemplateStringsArray) =>
  strings.reduce((acc, part, i) => `${acc}$${i - 1}${part}`);

const LISTING =
  /^\s*SELECT DISTINCT o\.id, o\.name\s+FROM org o\s+JOIN org_rulebook rb ON rb\.org_id = o\.id\s+WHERE o\.status = 'active'\s*$/;
const ORG_READ = /SELECT ([\w, ]+) FROM org WHERE id = \$(\d+)::uuid/;
const CHECKPOINT_READ =
  /SELECT last_checked_at FROM org_rule_alert_checkpoint\s+WHERE org_id = \$(\d+)::uuid/;
const CHANGES =
  /SELECT pr\.payer_id, p\.name AS payer_name, pr\.state, COUNT\(\*\) AS n\s+FROM payer_rule pr\s+JOIN payer p ON p\.id = pr\.payer_id\s+WHERE pr\.effective_date >= \$(\d+)::date\s+AND EXISTS \(\s*SELECT 1 FROM org_rulebook_row rb\s+WHERE rb\.org_id = \$(\d+)::uuid\s+AND rb\.payer_id = pr\.payer_id\s+AND rb\.state\s+= pr\.state\s*\)\s+GROUP BY pr\.payer_id, p\.name, pr\.state/;
const UPSERT =
  /INSERT INTO org_rule_alert_checkpoint \(org_id, last_checked_at\)\s+VALUES \(\$(\d+)::uuid, \$(\d+)::timestamptz\)\s+ON CONFLICT \(org_id\) DO UPDATE SET last_checked_at = EXCLUDED\.last_checked_at/;
const RECIPIENTS =
  /SELECT DISTINCT u\.email\s+FROM user_permission up\s+JOIN app_user u ON u\.id = up\.user_id\s+WHERE up\.permission = '([\w.]+)'\s+AND u\.status = '(\w+)'(?:\s+AND up\.org_id = \$(\d+)::uuid)?\s*$/;
const BRANDING =
  /SELECT display_name, primary_color, logo_url FROM org_branding\s+WHERE org_id = \$(\d+)::uuid/;

/**
 * Active orgs with a rulebook, DISTINCT, as seen through `visible`: RLS on org
 * and org_rulebook (FORCE, `id/org_id = app.current_org_id()`), or none.
 */
function listing(visible: (orgId: string) => boolean) {
  const joined = ORGS.filter((o) => visible(o.id) && o.status === "active").flatMap((o) =>
    RULEBOOKS.filter((rb) => visible(rb.org_id) && rb.org_id === o.id).map(() => o),
  );
  return [...new Map(joined.map((o) => [o.id, { id: o.id, name: o.name }])).values()];
}

/** The tenant client as the app role with no GUC: app.current_org_id() is NULL. */
function tenantClientQuery(strings: TemplateStringsArray): Promise<unknown> {
  const sql = numbered(strings);
  if (LISTING.test(sql)) return Promise.resolve(listing(() => false));
  throw new Error(`the tenant client outside withOrgContext models no such statement: ${sql}`);
}

/** The admin (RLS-bypass) client withBreakglass hands its callback. */
const adminClient = {
  $queryRaw: (strings: TemplateStringsArray) => {
    const sql = numbered(strings);
    if (LISTING.test(sql)) return Promise.resolve(listing(() => true));
    throw new Error(`the admin client models no such statement: ${sql}`);
  },
  $executeRaw: (strings: TemplateStringsArray) => {
    throw new Error(`the admin client models no such statement: ${numbered(strings)}`);
  },
};

/**
 * A withOrgContext transaction with app.current_org_id = guc: the app role
 * under RLS, or (rls false) a connection that bypasses it, where the GUC is
 * set and bounds nothing.
 */
function fakeTx(sessionZone: string, guc: string, rls: boolean) {
  /** Whether a row of `orgId` is visible to this connection. */
  const sees = (orgId: string) => !rls || orgId === guc;
  const run = (strings: TemplateStringsArray, ...binds: unknown[]): Promise<unknown> => {
    const sql = numbered(strings);

    const orgRead = ORG_READ.exec(sql);
    if (orgRead) {
      const cols = orgRead[1]!.split(",").map((c) => c.trim());
      return Promise.resolve(
        ORGS.filter((o) => sees(o.id) && o.id === binds[Number(orgRead[2])]).map((o) =>
          Object.fromEntries(cols.map((c) => {
            if (!(c in o)) throw new Error(`org has no column ${c}`);
            return [c, o[c as keyof typeof o]];
          })),
        ),
      );
    }

    const ckRead = CHECKPOINT_READ.exec(sql);
    if (ckRead) {
      const orgId = String(binds[Number(ckRead[1])]);
      const lastCheckedAt = sees(orgId) ? checkpoints.get(orgId) : undefined;
      return Promise.resolve(lastCheckedAt ? [{ last_checked_at: lastCheckedAt }] : []);
    }

    if (sql.includes("FROM payer_rule pr")) {
      const m = CHANGES.exec(sql);
      if (!m) throw new Error(`the fake cannot evaluate the changes read: ${sql}`);
      const lo = asDate(binds[Number(m[1])], sessionZone);
      const orgId = binds[Number(m[2])];
      const groups = new Map<string, { payer_id: string; payer_name: string; state: string; n: bigint }>();
      for (const pr of PAYER_RULES) {
        if (pr.effective_date.toISOString().slice(0, 10) < lo) continue;
        // org_rulebook_row is FORCE RLS: another org's rows are invisible.
        const inScope = RULEBOOK_ROWS.some(
          (rb) => sees(rb.org_id) && rb.org_id === orgId && rb.payer_id === pr.payer_id && rb.state === pr.state,
        );
        if (!inScope) continue;
        const key = `${pr.payer_id}|${pr.state}`;
        const g = groups.get(key) ?? {
          payer_id: pr.payer_id,
          payer_name: PAYERS.find((p) => p.id === pr.payer_id)!.name,
          state: pr.state,
          n: BigInt(0),
        };
        g.n += BigInt(1);
        groups.set(key, g);
      }
      return Promise.resolve([...groups.values()]);
    }

    if (sql.includes("INSERT INTO org_rule_alert_checkpoint")) {
      const m = UPSERT.exec(sql);
      if (!m) throw new Error(`the fake cannot evaluate the checkpoint write: ${sql}`);
      const orgId = String(binds[Number(m[1])]);
      const checkedAt = binds[Number(m[2])];
      if (!(checkedAt instanceof Date)) throw new Error("the fake models only a Date bound into ::timestamptz");
      // The tenant policy is the WITH CHECK too (0035, 0052).
      if (!sees(orgId)) throw new Error("new row violates row-level security policy for table \"org_rule_alert_checkpoint\"");
      checkpoints.set(orgId, checkedAt);
      return Promise.resolve(1);
    }

    const recipients = RECIPIENTS.exec(sql);
    if (recipients) {
      // user_permission is FORCE RLS on org_id; app_user has no RLS. With RLS
      // bypassed, only the statement's own org predicate (if any) bounds it.
      const orgBind = recipients[3] === undefined ? undefined : binds[Number(recipients[3])];
      const emails = PERMISSIONS.filter(
        (up) => sees(up.org_id) && (orgBind === undefined || up.org_id === orgBind) && up.permission === recipients[1],
      )
        .map((up) => USERS.find((u) => u.id === up.user_id)!)
        .filter((u) => u.status === recipients[2])
        .map((u) => u.email);
      return Promise.resolve([...new Set(emails)].map((email) => ({ email })));
    }

    // No org has an org_branding row: the digest falls back to the org's name.
    if (BRANDING.test(sql)) return Promise.resolve([]);

    throw new Error(`the fake models no such statement: ${sql}`);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mockDatabase(sessionZone: string, rls = true) {
  h.tenantQueryRaw.mockImplementation(tenantClientQuery);
  vi.mocked(withBreakglass).mockImplementation((async (
    fn: (c: unknown) => Promise<unknown>,
    reason: string,
  ) => {
    if (!reason || reason.length < 10) {
      throw new Error("withBreakglass requires a reason of at least 10 chars.");
    }
    return fn(adminClient);
  }) as never);
  vi.mocked(withOrgContext).mockImplementation(async (orgId, fn) => {
    if (!UUID.test(orgId)) throw new Error("withOrgContext: orgId must be a UUID.");
    return (fn as (tx: unknown) => Promise<unknown>)(fakeTx(sessionZone, orgId, rls));
  });
}

const at = (iso: string) => vi.setSystemTime(new Date(iso));

/** digestsSent per dispatched org. */
async function dispatch(): Promise<Record<string, number>> {
  const out = await dispatchPayerRuleAlerts();
  return Object.fromEntries(out.map((s) => [s.orgId, s.digestsSent]));
}

/** What was emailed, to whom, sorted by recipient. */
const mails = () =>
  vi.mocked(sendEmail).mock.calls
    .map(([m]) => ({ to: m.to, subject: m.subject }))
    .sort((a, b) => a.to.localeCompare(b.to));

const SECRET = "test-cron-secret-0123456789abcdef";
let savedSecret: string | undefined;

const post = (secret: string) =>
  POST(
    new Request("http://localhost/api/cron/payer-rule-alerts", {
      method: "POST",
      headers: { "x-cron-secret": secret },
    }) as unknown as NextRequest,
  );

beforeEach(() => {
  checkpoints = new Map();
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  vi.useFakeTimers({ toFake: ["Date"] });
  // A fixed clock for every test; a test that depends on it sets its own.
  at("2026-03-10T15:00:00Z");
});

afterEach(() => {
  vi.useRealTimers();
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe.each(["UTC", "Asia/Karachi", "America/New_York"])(
  "payer-rule alerts, database session in %s",
  (sessionZone) => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(sendEmail).mockResolvedValue({ id: "dev", delivered: false });
      mockDatabase(sessionZone);
    });

    it("CONTROL: a check at 9 pm EST on 1 Mar reports New York's rules of 1 Mar, not 28 Feb's", async () => {
      checkpoints.set(ORG_NY, new Date("2026-03-02T02:00:00Z")); // 9 pm EST, 1 Mar
      checkpoints.set(ORG_LA, new Date("2026-03-02T08:00:00Z")); // midnight PST, 2 Mar
      expect(await dispatch()).toEqual({ [ORG_NY]: 1, [ORG_LA]: 0 });
      expect(mails()).toEqual([{ to: NY_ADMIN, subject: TWO_CHANGES }]);
    });

    it("CONTROL: a check at 10 pm PST on 1 Mar reports Los Angeles's rules of 1 Mar", async () => {
      checkpoints.set(ORG_LA, new Date("2026-03-02T06:00:00Z")); // 10 pm PST, 1 Mar
      checkpoints.set(ORG_NY, new Date("2026-03-02T05:00:00Z")); // midnight EST, 2 Mar
      expect(await dispatch()).toEqual({ [ORG_NY]: 0, [ORG_LA]: 1 });
      expect(mails()).toEqual([{ to: LA_ADMIN, subject: TWO_CHANGES }]);
    });

    it("CONTROL: with no checkpoint, at 10 pm EDT on 8 Mar each practice's week starts on 1 Mar", async () => {
      at("2026-03-09T02:00:00Z"); // 10 pm EDT / 7 pm PDT on Sun 8 Mar (DST began that morning)
      expect(await dispatch()).toEqual({ [ORG_NY]: 1, [ORG_LA]: 1 });
      expect(mails()).toEqual([
        { to: LA_ADMIN, subject: TWO_CHANGES },
        { to: NY_ADMIN, subject: TWO_CHANGES },
      ]);
    });

    it("CONTROL: with no checkpoint, at 11:30 pm PDT on 8 Mar Los Angeles's week starts on 1 Mar and New York's on 2 Mar", async () => {
      at("2026-03-09T06:30:00Z"); // 11:30 pm PDT on 8 Mar; 2:30 am EDT on 9 Mar
      expect(await dispatch()).toEqual({ [ORG_NY]: 0, [ORG_LA]: 1 });
      expect(mails()).toEqual([{ to: LA_ADMIN, subject: TWO_CHANGES }]);
    });

    it("CONTROL: with no checkpoint, at 12:30 am EDT on 9 Mar New York's week is 7 calendar days back (2 Mar), not 168 hours", async () => {
      at("2026-03-09T04:30:00Z"); // 12:30 am EDT on 9 Mar; 9:30 pm PDT on 8 Mar
      // DST began on 8 Mar, so New York's last week was 167 hours long: 168
      // hours back is 11:30 pm EST on 1 Mar, which would report 1 Mar's rules.
      expect(await dispatch()).toEqual({ [ORG_NY]: 0, [ORG_LA]: 1 });
      expect(mails()).toEqual([{ to: LA_ADMIN, subject: TWO_CHANGES }]);
    });

    it("CONTROL: every active practice with a rulebook is dispatched, though the tenant client sees no org without a GUC", async () => {
      // The app role with no GUC answers the listing with no rows (the dev
      // database: 3 orgs as admin, 0 after SET LOCAL ROLE app).
      const tpl = (s: TemplateStringsArray) => s;
      expect(await tenantClientQuery(tpl`
        SELECT DISTINCT o.id, o.name FROM org o JOIN org_rulebook rb ON rb.org_id = o.id WHERE o.status = 'active'
      `)).toEqual([]);

      checkpoints.set(ORG_NY, new Date("2026-03-02T05:00:00Z"));
      checkpoints.set(ORG_LA, new Date("2026-03-02T08:00:00Z"));
      const out = await dispatchPayerRuleAlerts();
      // Not the org without a rulebook, not the suspended one that has one.
      expect(out.map((s) => s.orgId).sort()).toEqual([ORG_NY, ORG_LA].sort());
      expect(out.find((s) => s.orgId === ORG_NY)!.orgName).toBe("Riverside Palliative");

      expect(withBreakglass).toHaveBeenCalledTimes(1);
      const reason = vi.mocked(withBreakglass).mock.calls[0]![1];
      expect(reason.length).toBeGreaterThanOrEqual(10);
      // A login/signup reason is not written to breakglass_log (lib/db.ts).
      expect(reason).not.toMatch(/^(login|signup)/i);
    });

    it("CONTROL: on a connection that bypasses RLS, a practice's digest goes to its own team.permissions holders only", async () => {
      // The preview deployment connects as a superuser (team.service.ts,
      // listMembers): FORCE RLS does not bind it and withOrgContext only sets
      // the GUC, so each statement must name the org itself.
      mockDatabase(sessionZone, false);
      checkpoints.set(ORG_NY, new Date("2026-03-02T02:00:00Z")); // 9 pm EST, 1 Mar
      checkpoints.set(ORG_LA, new Date("2026-03-02T08:00:00Z")); // midnight PST, 2 Mar
      expect(await dispatch()).toEqual({ [ORG_NY]: 1, [ORG_LA]: 0 });
      // Not Los Angeles's admin, nor the suspended hospice's.
      expect(mails()).toEqual([{ to: NY_ADMIN, subject: TWO_CHANGES }]);
    });

    it("twin: a check at midnight on 2 Mar, in each practice's zone, reports nothing and still advances", async () => {
      checkpoints.set(ORG_NY, new Date("2026-03-02T05:00:00Z")); // midnight EST, 2 Mar
      checkpoints.set(ORG_LA, new Date("2026-03-02T08:00:00Z")); // midnight PST, 2 Mar
      expect(await dispatch()).toEqual({ [ORG_NY]: 0, [ORG_LA]: 0 });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(checkpoints.get(ORG_NY)).toEqual(new Date("2026-03-10T15:00:00Z"));
      expect(checkpoints.get(ORG_LA)).toEqual(new Date("2026-03-10T15:00:00Z"));
    });

    it("twin: after a run each practice's checkpoint is the run's instant, with or without a digest", async () => {
      at("2026-03-10T03:15:00Z"); // the scheduled run
      // New York's window takes in every rule in any zone; Los Angeles's none.
      checkpoints.set(ORG_NY, new Date("2026-02-20T12:00:00Z"));
      checkpoints.set(ORG_LA, new Date("2026-03-02T08:00:00Z"));
      expect(await dispatch()).toEqual({ [ORG_NY]: 1, [ORG_LA]: 0 });
      expect(checkpoints.get(ORG_NY)).toEqual(new Date("2026-03-10T03:15:00Z"));
      expect(checkpoints.get(ORG_LA)).toEqual(new Date("2026-03-10T03:15:00Z"));
      expect(checkpoints.has(ORG_NO_BOOK)).toBe(false);
      expect(checkpoints.has(ORG_SUSP)).toBe(false);
    });

    it("CONTROL: the cron route dispatches every practice and totals the digests it sent", async () => {
      // A checkpoint a week earlier: every rule in scope, in any zone.
      checkpoints.set(ORG_NY, new Date("2026-02-20T12:00:00Z"));
      checkpoints.set(ORG_LA, new Date("2026-02-20T12:00:00Z"));
      const res = await post(SECRET);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { ranAt: string; orgs: { orgId: string; digestsSent: number }[]; totalDigests: number };
      };
      expect(body.data.orgs.map((o) => o.orgId).sort()).toEqual([ORG_NY, ORG_LA].sort());
      expect(body.data.totalDigests).toBe(vi.mocked(sendEmail).mock.calls.length);
      expect(body.data.totalDigests).toBe(2);
      expect(body.data.ranAt).toBe("2026-03-10T15:00:00.000Z");
      const three = "Anthem BCBS Ohio (Elevance) (OH) — 3 rule changes";
      expect(mails()).toEqual([
        { to: LA_ADMIN, subject: three },
        { to: NY_ADMIN, subject: three },
      ]);
    });

    it("twin: the cron route with the wrong secret is 401 and reads nothing", async () => {
      const res = await post("not-the-secret");
      expect(res.status).toBe(401);
      expect(withBreakglass).not.toHaveBeenCalled();
      expect(withOrgContext).not.toHaveBeenCalled();
      expect(h.tenantQueryRaw).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
    });
  },
);
