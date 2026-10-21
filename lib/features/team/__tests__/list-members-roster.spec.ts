/**
 * The roster on /team is org_member, not "whoever happens to hold a grant".
 *
 * listMembers used to be driven FROM user_permission, so a member with no
 * permission rows produced no GROUP BY group and never appeared: on the Design
 * Partner org that was three of five active members (consultant, employee and
 * reviewer), none of whom could be seen, edited or granted anything — the only
 * way back was to re-invite them.
 *
 * The query the service writes is RUN here, by ./sql-fake, against in-memory
 * tables that keep members and grants apart. The previous fake answered by
 * grepping the SQL for "FROM org_member" and returning a fixed list, so adding
 * `HAVING count(up.permission) > 0` (the same bug by another route) left it
 * 6/6 green. Now anything that filters out members with no grants, whether by
 * HAVING, an INNER JOIN or a WHERE on up.*, drops the consultant from what
 * these tests read, and they fail on that.
 *
 * The tables hold two orgs and there is no RLS, which is what a superuser
 * connection sees. The query has to stay inside its org on its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { listMembers } from "../team.service";
import { CannotModel, fakeTx, run, type FakeDb } from "./sql-fake";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MULTI = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONSULTANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OUTSIDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FORMER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const INVITE = "99999999-9999-4999-8999-999999999999";

const grant = (org_id: string, user_id: string, permission: string) => ({
  org_id,
  user_id,
  pending_invite_id: null,
  permission,
  granted_by_user_id: ADMIN,
});

/**
 * Mirrors the local demo data: a grant-holder, a member with none, a removed
 * member, and multi@example.test, who belongs to both orgs with different
 * grants and is a rendering provider only in the other one. Rows are
 * deliberately NOT in email order, so the query has to do the sorting.
 */
function demoDb(): FakeDb {
  return {
    org_member: {
      columns: ["org_id", "user_id", "status"],
      rows: [
        { org_id: ORG, user_id: MULTI, status: "active" },
        { org_id: ORG, user_id: CONSULTANT, status: "active" },
        { org_id: OTHER_ORG, user_id: OUTSIDER, status: "active" },
        { org_id: ORG, user_id: FORMER, status: "removed" },
        { org_id: ORG, user_id: ADMIN, status: "active" },
        { org_id: OTHER_ORG, user_id: MULTI, status: "active" },
      ],
    },
    app_user: {
      columns: ["id", "email", "full_name"],
      rows: [
        { id: ADMIN, email: "admin@design-partner.test", full_name: "Test Admin" },
        { id: MULTI, email: "multi@example.test", full_name: "Multi Org" },
        { id: CONSULTANT, email: "consultant@design-partner.test", full_name: "Test Consultant" },
        { id: OUTSIDER, email: "outsider@other-org.test", full_name: "Other Org Member" },
        { id: FORMER, email: "former@design-partner.test", full_name: "Former Employee" },
      ],
    },
    user_permission: {
      columns: ["org_id", "user_id", "pending_invite_id", "permission", "granted_by_user_id"],
      unique: ["user_id", "org_id", "permission"],
      rows: [
        grant(ORG, ADMIN, "team.view"),
        grant(ORG, ADMIN, "patients.list"),
        grant(ORG, FORMER, "patients.list"),
        grant(ORG, MULTI, "visits.view.own"),
        grant(OTHER_ORG, MULTI, "billing.lookup.view"),
        grant(OTHER_ORG, MULTI, "audit.view"),
        grant(OTHER_ORG, OUTSIDER, "patients.list"),
        // An outstanding invite's grants: no user yet.
        { org_id: ORG, user_id: null, pending_invite_id: INVITE, permission: "patients.view", granted_by_user_id: ADMIN },
      ],
    },
    clinician_profile: {
      columns: ["org_id", "user_id", "npi", "credential"],
      rows: [
        { org_id: ORG, user_id: ADMIN, npi: "1234567893", credential: "MD" },
        { org_id: OTHER_ORG, user_id: MULTI, npi: "1245319599", credential: "NP" },
      ],
    },
  };
}

let db: FakeDb;

beforeEach(() => {
  db = demoDb();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx(db)),
  );
});

describe("listMembers — org_member is the roster of record", () => {
  it("lists an active member who holds no permissions at all", async () => {
    const rows = await listMembers({ orgId: ORG });
    const emails = rows.map((r) => r.email);
    expect(emails).toContain("consultant@design-partner.test");
    const consultant = rows.find((r) => r.email === "consultant@design-partner.test");
    expect(consultant?.permissions).toEqual([]);
  });

  it("lists every member of the org, grant or no grant, each once", async () => {
    const rows = await listMembers({ orgId: ORG });
    expect(rows.map((r) => r.email).sort()).toEqual([
      "admin@design-partner.test",
      "consultant@design-partner.test",
      "former@design-partner.test",
      "multi@example.test",
    ]);
  });

  it("still carries the billing identity the roster renders (audit R40, R25)", async () => {
    const rows = await listMembers({ orgId: ORG });
    const admin = rows.find((r) => r.email === "admin@design-partner.test");
    expect(admin).toEqual({
      userId: ADMIN,
      email: "admin@design-partner.test",
      fullName: "Test Admin",
      permissions: ["patients.list", "team.view"],
      npi: "1234567893",
      credential: "MD",
    });
  });

  it("activeOnly drops a member who is no longer active, keeps one with no permissions", async () => {
    const rows = await listMembers({ orgId: ORG, activeOnly: true });
    const emails = rows.map((r) => r.email);
    expect(emails).not.toContain("former@design-partner.test");
    expect(emails).toContain("consultant@design-partner.test");
    expect(emails).toHaveLength(3);
  });

  it("gives a two-org member only this org's grants and billing identity — the editor writes that set back wholesale", async () => {
    const rows = await listMembers({ orgId: ORG });
    expect(rows.filter((r) => r.userId === MULTI)).toEqual([
      {
        userId: MULTI,
        email: "multi@example.test",
        fullName: "Multi Org",
        permissions: ["visits.view.own"],
        npi: null,
        credential: null,
      },
    ]);
  });

  it("stays inside its org with nothing else holding it there (no RLS in this fake)", async () => {
    const rows = await listMembers({ orgId: ORG });
    expect(rows.map((r) => r.email)).not.toContain("outsider@other-org.test");
  });

  it("keeps the roster ordered by email", async () => {
    const emails = (await listMembers({ orgId: ORG })).map((r) => r.email);
    expect(emails).toEqual([...emails].sort());
  });
});

/**
 * The spec above is only as honest as the fake. These pin the behaviour it
 * relies on, so the fake cannot be "simplified" back into something that
 * returns every member whatever the query says.
 */
describe("sql-fake — what the roster spec depends on", () => {
  const roster = (extra: string) => [
    `SELECT om.user_id, count(up.permission) AS n FROM org_member om
       ${extra.includes("INNER") ? "JOIN" : "LEFT JOIN"} user_permission up
         ON up.user_id = om.user_id AND up.org_id = om.org_id
      WHERE om.org_id = `,
    ` GROUP BY om.user_id ${extra.includes("HAVING") ? "HAVING count(up.permission) > 0" : ""}`,
  ];
  const ids = (r: unknown) => (r as { user_id: string }[]).map((x) => x.user_id);

  it("keeps a member with no grants through a LEFT JOIN, with a count of 0", () => {
    const r = run(demoDb(), roster(""), [ORG]) as { user_id: string; n: number }[];
    expect(r.find((x) => x.user_id === CONSULTANT)?.n).toBe(0);
  });

  it("drops that member for an INNER JOIN and for HAVING count(...) > 0", () => {
    expect(ids(run(demoDb(), roster("INNER"), [ORG]))).not.toContain(CONSULTANT);
    expect(ids(run(demoDb(), roster("HAVING"), [ORG]))).not.toContain(CONSULTANT);
  });

  it("refuses SQL it does not model instead of guessing", () => {
    expect(() =>
      run(demoDb(), ["SELECT user_id FROM org_member WHERE NOT EXISTS (SELECT 1)"], []),
    ).toThrow(CannotModel);
  });
});
