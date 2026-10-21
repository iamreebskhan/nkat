/**
 * createTimeOff must refuse a clinician who is not an active member of the
 * booking org.
 *
 * time_off.clinician_user_id is a bare FK to app_user, which is global and
 * has no RLS, so the database accepts any user id at all. The Add PTO picker
 * only lists active members, but the picker is not the server: a direct POST
 * to /api/time-off could block out a removed member's calendar, or a user id
 * belonging to ANOTHER ORG, which then draws a PTO bar on this org's schedule
 * under a stranger's name.
 *
 * These run the real createTimeOff against a fake tx that models org_member
 * as rows of (org_id, user_id, status), so the guard's org_id and
 * status = 'active' predicates both have to be there for the refusals to
 * happen — and every refusal asserts that NOTHING was inserted.
 *
 * THE CALLER IS A SEPARATE QUESTION, and it lives in
 * time-off-ownership.spec.ts. Every booking here is made by a caller who may
 * write to anyone's calendar, so that a refusal in this file can only ever be
 * about the SUBJECT's membership. Both rules were missing at once and were
 * mistaken for each other: the org_member lookup binds the clinician being
 * booked and never the caller, so it is silent about who is asking.
 *
 * The fake models time_off as ROWS as well, because the delete control below
 * used to be answered by `if (sql.includes("DELETE FROM time_off")) return 1`.
 * That answered any delete, so the statement could be narrowed, widened to no
 * WHERE clause at all, or left unguarded, and this file stayed green either
 * way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import { VIEW_ANY_VISIT } from "@/lib/features/visits/visit-access";
import { createTimeOff, deleteTimeOff } from "../time-off.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "aaaa1111-1111-4111-8111-111111111111";
const PTO = "22222222-2222-4222-8222-222222222222";
const CREATOR = "99999999-9999-4999-8999-999999999999";
const ACTIVE = "33333333-3333-4333-8333-333333333333";
const REMOVED = "44444444-4444-4444-8444-444444444444";
const SUSPENDED = "55555555-5555-4555-8555-555555555555";
const INVITED = "66666666-6666-4666-8666-666666666666";
/** An active member of a DIFFERENT tenant — invisible here under RLS. */
const STRANGER = "77777777-7777-4777-8777-777777777777";
/** A user id with no org_member row anywhere. */
const NOBODY = "88888888-8888-4888-8888-888888888888";

interface MemberRow {
  org_id: string;
  user_id: string;
  status: string;
}

const MEMBERS: MemberRow[] = [
  { org_id: ORG, user_id: ACTIVE, status: "active" },
  { org_id: ORG, user_id: REMOVED, status: "removed" },
  { org_id: ORG, user_id: SUSPENDED, status: "suspended" },
  { org_id: ORG, user_id: INVITED, status: "invited" },
  { org_id: OTHER_ORG, user_id: STRANGER, status: "active" },
];

/**
 * The booking caller throughout this file: an org admin, i.e. the shipped
 * clinician template plus the one permission that lifts the ownership test
 * (visits.view.all). Built from the templates rather than typed out, so if
 * either ever changes this file changes with it.
 */
const BOOKS_FOR_ANYONE = [...ROLE_DEFAULT_PERMISSIONS.clinician, VIEW_ANY_VISIT];

interface TimeOffRow {
  id: string;
  clinician_user_id: string;
  start_date: Date;
  end_date: Date;
  reason: string | null;
}

let calls: { sql: string; values: unknown[] }[] = [];
/** The fake database's time_off table. Statements act on THESE rows. */
let timeOffRows: TimeOffRow[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM org_member")) {
      // Bindings are (org_id, clinician_user_id). status = 'active' is a
      // literal in the SQL, so honour it only when the SQL actually says it:
      // drop that predicate and the removed/suspended/invited rows come back,
      // which is exactly the regression these tests exist to catch.
      const wantsActive = sql.includes("status = 'active'");
      const scopedToOrg = sql.includes("org_id =");
      const hit = MEMBERS.find(
        (m) =>
          (!scopedToOrg || m.org_id === values[0]) &&
          m.user_id === values[1] &&
          (!wantsActive || m.status === "active"),
      );
      return Promise.resolve(hit ? [{ ok: 1 }] : []);
    }
    if (sql.includes("INSERT INTO time_off")) {
      // Bindings are (org_id, clinician_user_id, start, end, reason, created_by).
      timeOffRows.push({
        id: PTO,
        clinician_user_id: String(values[1]),
        start_date: new Date(`${String(values[2])}T00:00:00Z`),
        end_date: new Date(`${String(values[3])}T00:00:00Z`),
        reason: (values[4] as string | null) ?? null,
      });
      return Promise.resolve([{ id: PTO }]);
    }
    if (sql.includes("DELETE FROM time_off")) {
      // Removes the rows the bound id matches, and reports how many — the
      // count the service reads. A delete of a row that is not there is 0, not
      // a cheerful 1.
      const before = timeOffRows.length;
      timeOffRows = timeOffRows.filter((r) => r.id !== values[0]);
      return Promise.resolve(before - timeOffRows.length);
    }
    if (sql.includes("FROM time_off")) {
      const hit = timeOffRows.find((r) => r.id === values[0]);
      return Promise.resolve(hit ? [hit] : []);
    }
    if (sql.includes("INSERT INTO audit_log")) return Promise.resolve(1);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  timeOffRows = [];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const argsFor = (clinicianUserId: string, orgId = ORG) => ({
  orgId,
  createdBy: CREATOR,
  createdByPermissions: BOOKS_FOR_ANYONE,
  clinicianUserId,
  startDate: "2026-10-05",
  endDate: "2026-10-09",
  reason: "vacation",
});

const inserted = () => calls.filter((c) => c.sql.includes("INSERT INTO time_off"));

/** The refusal message, or a loud failure if the booking was accepted. */
async function refusalFor(userId: string): Promise<string> {
  try {
    await createTimeOff(argsFor(userId));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`createTimeOff accepted ${userId} instead of refusing it.`);
}

describe("createTimeOff — the clinician must be an active member of this org", () => {
  for (const [label, userId] of [
    ["a removed member", REMOVED],
    ["a suspended member", SUSPENDED],
    ["an invited member who never joined", INVITED],
    ["an active member of another org", STRANGER],
    ["a user id with no membership anywhere", NOBODY],
  ] as const) {
    it(`refuses ${label}, and writes no PTO row`, async () => {
      await expect(createTimeOff(argsFor(userId))).rejects.toThrow(
        /is not an active member of this organization/,
      );
      expect(inserted()).toHaveLength(0);
    });
  }

  it("gives the never-a-member and the removed member the SAME refusal", async () => {
    // Deliberate: RLS hides other orgs' org_member rows, so the server cannot
    // tell "belongs to another tenant" from "no such user" — and spelling out
    // which would leak whether a user id exists elsewhere. The remedy is
    // identical either way, so the message is too.
    const strip = (m: string) => m.replace(/[0-9a-f-]{36}/, "<id>");
    const removed = strip(await refusalFor(REMOVED));
    expect(strip(await refusalFor(STRANGER))).toBe(removed);
    expect(strip(await refusalFor(NOBODY))).toBe(removed);
  });

  it("refuses with a 422 ValidationError naming the id and what to do instead", async () => {
    const err = await createTimeOff(argsFor(REMOVED)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(REMOVED);
    expect((err as Error).message).toMatch(/Pick someone from the Clinician list\./);
  });

  it("asks org_member about THIS org and THIS clinician", async () => {
    await createTimeOff(argsFor(ACTIVE));
    const q = calls.find((c) => c.sql.includes("FROM org_member"));
    expect(q).toBeDefined();
    expect(q!.values[0]).toBe(ORG);
    expect(q!.values[1]).toBe(ACTIVE);
    expect(q!.sql).toContain("status = 'active'");
  });

  it("CONTROL: an active member gets PTO booked normally", async () => {
    const r = await createTimeOff(argsFor(ACTIVE));
    expect(r).toEqual({ id: PTO });
    expect(inserted()).toHaveLength(1);
    expect(inserted()[0]!.values).toContain(ACTIVE);
  });

  it("CONTROL: the same stranger books fine in the org they actually belong to", async () => {
    // Proves the refusal is about membership in the BOOKING org, not about
    // this particular user id being blacklisted.
    const r = await createTimeOff(argsFor(STRANGER, OTHER_ORG));
    expect(r).toEqual({ id: PTO });
    expect(inserted()).toHaveLength(1);
  });

  it("CONTROL: PTO already on the books for a since-removed member is still deletable", async () => {
    // The guard stops new bookings; it must not strand rows that predate it,
    // or a schedule showing a stranger's PTO could never be cleaned up.
    // Removed by an admin: a member who has left cannot come back and clear
    // their own leave, so if this needed the owner it could not be done at all.
    timeOffRows = [
      {
        id: PTO,
        clinician_user_id: REMOVED,
        start_date: new Date("2026-10-05T00:00:00Z"),
        end_date: new Date("2026-10-09T00:00:00Z"),
        reason: null,
      },
    ];
    const r = await deleteTimeOff({
      orgId: ORG,
      id: PTO,
      callerUserId: CREATOR,
      callerPermissions: BOOKS_FOR_ANYONE,
    });
    expect(r).toEqual({ deleted: true });
    // The row is gone from the table, not merely reported gone.
    expect(timeOffRows).toHaveLength(0);
    expect(calls.some((c) => c.sql.includes("FROM org_member"))).toBe(false);
  });
});
