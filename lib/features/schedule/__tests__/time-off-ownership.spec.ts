/**
 * Whose calendar a PTO row belongs to, and who may write to it.
 *
 * WHAT WAS BROKEN. DELETE /api/time-off/[id] gated on schedule.edit and then
 * handed the path id straight to deleteTimeOff, whose entire body was
 * `DELETE FROM time_off WHERE id = $1`. schedule.edit is on the shipped
 * clinician template — "so they can move their own visits on the week grid"
 * (lib/features/team/team.types.ts) — so every clinician passed the gate, and
 * nothing below it ever read clinician_user_id. In the demo org that is six
 * schedule.edit holders among eight active members, any of whom could clear
 * any other's approved leave: the day freed up on the grid, and time-off.service
 * contained no writeAudit call at all, so no row anywhere said who did it. RLS
 * does not help — time_off carries one policy, tenant_isolation on org_id — so
 * the tenant boundary held and nothing inside the org was constrained. POST was
 * the same hole from the other side: the membership guard bound the SUBJECT's
 * user id and never the caller's, so a clinician could book leave onto a
 * colleague's calendar, and the Add PTO composer offers every active member in
 * a dropdown.
 *
 * WHY THE OLD SPEC DID NOT CATCH IT. time-off-clinician-membership.spec.ts had
 * one line for the whole delete path: `if (sql.includes("DELETE FROM time_off"))
 * return Promise.resolve(1)`. A fake that answers a delete unconditionally
 * cannot tell an ownership-scoped delete from an unscoped one from
 * `DELETE FROM time_off` with no WHERE clause at all — the audit ran all three
 * and got 11/11 green from each.
 *
 * SO THIS FILE MODELS THE DATA. The fake tx holds a time_off table as rows and
 * an audit_log as rows; the real statements act on them, and the assertions
 * read the table afterwards. The rule itself is never restated in JavaScript:
 * refusal is proved by the row still being there and no delete having been
 * issued, permission is proved against the shipped role templates rather than
 * against a list typed out here, and the table and owner column come from the
 * migration that declares them rather than from the service under test.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));

import { type NextRequest } from "next/server";

import { fail } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import { VIEW_ANY_VISIT } from "@/lib/features/visits/visit-access";

import { DELETE as deleteRoute } from "@/app/api/time-off/[id]/route";
import { POST as createRoute } from "@/app/api/time-off/route";

import { createTimeOff, deleteTimeOff, PTO_NOT_YOUR_CALENDAR } from "../time-off.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLLEAGUE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MY_PTO = "d0000000-0000-4000-8000-00000000000d";
const THEIR_PTO = "e0000000-0000-4000-8000-00000000000e";
const NEW_PTO = "f0000000-0000-4000-8000-00000000000f";
const NO_SUCH_PTO = "09999999-9999-4999-8999-999999999999";

/** The shipped templates, imported rather than retyped. */
const CLINICIAN = ROLE_DEFAULT_PERMISSIONS.clinician;
const ORG_ADMIN = ROLE_DEFAULT_PERMISSIONS.org_admin;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Table and owner column taken from the migration that creates them, not from
 * the service. Matching the service's SQL against a string copied out of the
 * service proves only that the file agrees with itself.
 */
function timeOffSchema(): { table: string; owner: string } {
  const file = path.join(REPO_ROOT, "db", "migrations", "0051_phase_pallio_time_off_and_capacity.sql");
  const sql = fs.readFileSync(file, "utf8");
  const create = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/.exec(sql);
  if (!create) throw new Error(`${file} no longer contains the CREATE TABLE this spec reads`);
  const owner = /\n\s+(clinician_user_id)\s+UUID/.exec(create[2]!);
  if (!owner) throw new Error(`${create[1]} no longer declares clinician_user_id — whose leave is a row now?`);
  return { table: create[1]!, owner: owner[1]! };
}

const SCHEMA = timeOffSchema();
const OWNER_READ = new RegExp(`^\\s*SELECT\\b[\\s\\S]*\\b${SCHEMA.owner}\\b[\\s\\S]*\\bFROM\\s+${SCHEMA.table}\\b`, "i");
const DELETE_ROW = new RegExp(`^\\s*DELETE\\s+FROM\\s+${SCHEMA.table}\\b`, "i");
const INSERT_ROW = new RegExp(`^\\s*INSERT\\s+INTO\\s+${SCHEMA.table}\\b`, "i");

interface TimeOffRow {
  id: string;
  clinician_user_id: string;
  start_date: Date;
  end_date: Date;
  reason: string | null;
}

interface AuditRow {
  org_id: unknown;
  user_id: unknown;
  action: unknown;
  target_type: unknown;
  target_id: unknown;
  payload: Record<string, unknown>;
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let calls: { sql: string; values: unknown[] }[] = [];
let timeOff: TimeOffRow[] = [];
let auditRows: AuditRow[] = [];
/** Active members of ORG, for createTimeOff's subject guard. */
let activeMembers: string[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });

    if (DELETE_ROW.test(sql)) {
      const before = timeOff.length;
      if (values.length === 0) {
        // A delete with nothing bound removes every row in the org, because
        // that is what the statement says. Modelled rather than refused: a
        // WHERE clause that goes missing should be something the assertions
        // can see, not a shape this fake declines to consider.
        timeOff = [];
      } else if (values.length === 1) {
        timeOff = timeOff.filter((r) => r.id !== values[0]);
      } else {
        // More binds than the shipped statement has means the fake would be
        // modelling a different statement than the one that ran.
        throw new Error(
          `The delete now binds ${values.length} values; teach this fake what they mean ` +
            `before trusting what it reports deleted.\n${sql}`,
        );
      }
      return Promise.resolve(before - timeOff.length);
    }
    if (OWNER_READ.test(sql)) {
      const hit = timeOff.find((r) => r.id === values[0]);
      return Promise.resolve(hit ? [hit] : []);
    }
    if (INSERT_ROW.test(sql)) {
      // Bindings: (org_id, clinician_user_id, start, end, reason, created_by).
      timeOff.push({
        id: NEW_PTO,
        clinician_user_id: String(values[1]),
        start_date: day(String(values[2])),
        end_date: day(String(values[3])),
        reason: (values[4] as string | null) ?? null,
      });
      return Promise.resolve([{ id: NEW_PTO }]);
    }
    if (/FROM\s+org_member/i.test(sql)) {
      return Promise.resolve(activeMembers.includes(String(values[1])) ? [{ ok: 1 }] : []);
    }
    if (/INSERT\s+INTO\s+audit_log/i.test(sql)) {
      auditRows.push({
        org_id: values[0],
        user_id: values[1],
        action: values[2],
        target_type: values[3],
        target_id: values[4],
        payload: JSON.parse(String(values[5])) as Record<string, unknown>,
      });
      return Promise.resolve(1);
    }
    // Loud rather than empty: an unrecognised statement answered with [] reads
    // as "no such row" and would turn a missing guard into a plausible 404.
    return Promise.reject(new Error(`fakeTx does not recognise this statement:\n${sql}`));
  };
  return { $queryRaw: run, $executeRaw: run };
}

function session(userId: string, permissions: string[]) {
  return { userId, orgId: ORG, permissions, role: "clinician", email: "who@example.test" };
}

/**
 * requireAuth with its own rule applied rather than stubbed away: the caller
 * needs every permission the handler lists. Without this a test could "prove"
 * that a billing agent reaches the delete, which no shipped template does.
 */
function signInAs(userId: string, permissions: string[]) {
  vi.mocked(requireAuth).mockImplementation(async (required: string[] = []) => {
    const missing = required.filter((p) => !permissions.includes(p));
    return (
      missing.length > 0
        ? fail(`Permission denied: missing ${missing.join(", ")}.`, { status: 403 })
        : session(userId, permissions)
    ) as never;
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const plainReq = new Request("http://localhost/x", { method: "DELETE" }) as unknown as NextRequest;
/** A body can only be read once, so every call builds its own request. */
const jsonReq = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

const bookingFor = (clinicianUserId: string) => ({
  clinicianUserId,
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  reason: "vacation",
});

const deletes = () => calls.filter((c) => DELETE_ROW.test(c.sql));
const inserts = () => calls.filter((c) => INSERT_ROW.test(c.sql));
const memberLookups = () => calls.filter((c) => /FROM\s+org_member/i.test(c.sql));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  auditRows = [];
  activeMembers = [ME, COLLEAGUE, ADMIN];
  timeOff = [
    { id: MY_PTO, clinician_user_id: ME, start_date: day("2026-10-05"), end_date: day("2026-10-09"), reason: "vacation" },
    { id: THEIR_PTO, clinician_user_id: COLLEAGUE, start_date: day("2026-10-12"), end_date: day("2026-10-13"), reason: "surgery" },
  ];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
  signInAs(ME, CLINICIAN);
});

describe("the premise: schedule.edit and schedule.create are not ownership gates", () => {
  it("is what the shipped clinician template grants, so the guard is the only thing narrowing it", () => {
    // Asserted against the template rather than against a route comment. If
    // schedule.edit ever left the clinician template this should fail and be
    // re-read, not quietly make the guard redundant.
    expect(CLINICIAN).toContain("schedule.edit");
    expect(CLINICIAN).toContain("schedule.create");
    expect(CLINICIAN).not.toContain(VIEW_ANY_VISIT);
  });

  it("org_admin is the template that does lift it", () => {
    expect(ORG_ADMIN).toContain("schedule.edit");
    expect(ORG_ADMIN).toContain(VIEW_ANY_VISIT);
  });
});

describe("deleteTimeOff — a clinician may remove their own leave and no one else's", () => {
  it("refuses a colleague's row: nothing deleted, nothing audited", async () => {
    const r = await deleteTimeOff({
      orgId: ORG,
      id: THEIR_PTO,
      callerUserId: ME,
      callerPermissions: CLINICIAN,
    });
    expect(r).toEqual({ deleted: false, refusedReason: "Permission denied" });
    // The row is still on the books — the refusal is a fact about the table,
    // not about the return value.
    expect(timeOff.map((t) => t.id)).toContain(THEIR_PTO);
    // No delete was even attempted, so a guard that deleted first and refused
    // afterwards could not pass this.
    expect(deletes()).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("CONTROL: the same caller removes their OWN leave", async () => {
    // Without this the test above would pass just as well against a delete
    // that refuses everybody, and a clinician could never cancel their own PTO.
    const r = await deleteTimeOff({
      orgId: ORG,
      id: MY_PTO,
      callerUserId: ME,
      callerPermissions: CLINICIAN,
    });
    expect(r).toEqual({ deleted: true });
    expect(timeOff.map((t) => t.id)).not.toContain(MY_PTO);
    // That row and only that row: a delete that lost its WHERE clause would
    // clear the whole org's leave and still report this one gone.
    expect(timeOff.map((t) => t.id)).toContain(THEIR_PTO);
  });

  it("lets a caller holding visits.view.all remove anyone's", async () => {
    const r = await deleteTimeOff({
      orgId: ORG,
      id: THEIR_PTO,
      callerUserId: ADMIN,
      callerPermissions: ORG_ADMIN,
    });
    expect(r).toEqual({ deleted: true });
    expect(timeOff.map((t) => t.id)).not.toContain(THEIR_PTO);
  });

  it("answers 'no such row' without a refusal for an id this tenant does not have", async () => {
    const r = await deleteTimeOff({
      orgId: ORG,
      id: NO_SUCH_PTO,
      callerUserId: ME,
      callerPermissions: CLINICIAN,
    });
    // deleted:false with no refusedReason — the route turns this into 404 and
    // the refusal above into 403, so the two cannot be confused.
    expect(r).toEqual({ deleted: false });
    expect(deletes()).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});

describe("deleteTimeOff — the audit row", () => {
  it("names who deleted whose, and is written after the delete in the same transaction", async () => {
    await deleteTimeOff({
      orgId: ORG,
      id: THEIR_PTO,
      callerUserId: ADMIN,
      callerPermissions: ORG_ADMIN,
    });
    expect(auditRows).toHaveLength(1);
    const a = auditRows[0]!;
    expect(a.org_id).toBe(ORG);
    // Who did it.
    expect(a.user_id).toBe(ADMIN);
    // Whose leave it was. target_type is asserted alongside target_id because
    // the pair is read as a pair: summarizeAuditPayload (audit-pure.ts) sends
    // target_type === "visit" down its default branch, which returns
    // visitId: onVisit — so "visit" here would make /audit draw an "Open visit"
    // link on a time_off_delete row pointing at a USER id. All 23 tests here
    // stayed green under that one-word change until this line.
    expect(a.target_type).toBe("user");
    expect(a.target_id).toBe(COLLEAGUE);
    expect(a.payload.clinicianUserId).toBe(COLLEAGUE);
    expect(a.payload.removedOwnLeave).toBe(false);
    // The row is gone by then, so the entry has to carry what was lost.
    expect(a.payload.timeOffId).toBe(THEIR_PTO);
    expect(a.payload.startDate).toBe("2026-10-12");
    expect(a.payload.endDate).toBe("2026-10-13");
    // Ordering is the "same transaction" claim made observable: the audit
    // insert is issued after the delete, on the same tx, so it commits with it.
    const order = calls.map((c) => c.sql);
    expect(order.findIndex((s) => /INSERT\s+INTO\s+audit_log/i.test(s))).toBeGreaterThan(
      order.findIndex((s) => DELETE_ROW.test(s)),
    );
  });

  it("records a clinician clearing their own leave as their own", async () => {
    await deleteTimeOff({ orgId: ORG, id: MY_PTO, callerUserId: ME, callerPermissions: CLINICIAN });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.user_id).toBe(ME);
    expect(auditRows[0]!.payload.clinicianUserId).toBe(ME);
    expect(auditRows[0]!.payload.removedOwnLeave).toBe(true);
  });

  it("carries the fact of a reason, never the reason itself", async () => {
    // audit-write.ts: ids, field names and counts, never free text. THEIR_PTO
    // is booked with the reason "surgery", which is exactly the kind of string
    // an audit row readable by every org admin must not copy.
    await deleteTimeOff({
      orgId: ORG,
      id: THEIR_PTO,
      callerUserId: ADMIN,
      callerPermissions: ORG_ADMIN,
    });
    const a = auditRows[0]!;
    expect(a.payload.hadReason).toBe(true);
    expect(Object.keys(a.payload)).not.toContain("reason");
    expect(JSON.stringify(a.payload)).not.toContain("surgery");
  });
});

describe("createTimeOff — a clinician may book their own leave and no one else's", () => {
  const args = (createdBy: string, permissions: string[], subject: string) => ({
    orgId: ORG,
    createdBy,
    createdByPermissions: permissions,
    clinicianUserId: subject,
    startDate: "2026-11-02",
    endDate: "2026-11-06",
    reason: "vacation",
  });

  it("refuses a booking onto a colleague's calendar, before it looks anything up", async () => {
    const r = await createTimeOff(args(ME, CLINICIAN, COLLEAGUE));
    expect(r).toEqual({ id: null, refusedReason: PTO_NOT_YOUR_CALENDAR });
    expect(inserts()).toHaveLength(0);
    // Not even the membership lookup ran: a caller with no claim on this
    // calendar is not told whether the colleague they named is still on the
    // roster.
    expect(memberLookups()).toHaveLength(0);
  });

  it("the refusal tells the clinician what they may do instead", () => {
    // Copy a person reads, pinned as written — the Add PTO composer puts this
    // sentence in its red box.
    expect(PTO_NOT_YOUR_CALENDAR).toContain("only book time off on your own calendar");
    expect(PTO_NOT_YOUR_CALENDAR).toContain("can book it for someone else");
  });

  it("CONTROL: the same clinician books their own leave", async () => {
    const r = await createTimeOff(args(ME, CLINICIAN, ME));
    expect(r).toEqual({ id: NEW_PTO });
    expect(inserts()).toHaveLength(1);
    expect(timeOff.find((t) => t.id === NEW_PTO)?.clinician_user_id).toBe(ME);
  });

  it("lets a caller holding visits.view.all book for anyone", async () => {
    const r = await createTimeOff(args(ADMIN, ORG_ADMIN, COLLEAGUE));
    expect(r).toEqual({ id: NEW_PTO });
    expect(timeOff.find((t) => t.id === NEW_PTO)?.clinician_user_id).toBe(COLLEAGUE);
  });

  it("still refuses a non-member, even to a caller who may book for anyone", async () => {
    // The two rules are independent: the caller test does not replace the
    // subject test, it runs in front of it.
    activeMembers = [ME, ADMIN];
    await expect(createTimeOff(args(ADMIN, ORG_ADMIN, COLLEAGUE))).rejects.toThrow(
      /is not an active member of this organization/,
    );
    expect(inserts()).toHaveLength(0);
  });
});

describe("DELETE /api/time-off/[id] — the real handler", () => {
  it("answers 403 on a colleague's PTO and leaves the row alone", async () => {
    const res = await deleteRoute(plainReq, ctx(THEIR_PTO));
    expect(res.status).toBe(403);
    // The same words requireVisitAccess answers for the same refusal on the
    // same week grid.
    expect(await res.json()).toEqual({ success: false, data: null, error: "Permission denied" });
    expect(timeOff.map((t) => t.id)).toContain(THEIR_PTO);
    expect(deletes()).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("CONTROL: answers 200 on the caller's own PTO, removes it, and audits it", async () => {
    const res = await deleteRoute(plainReq, ctx(MY_PTO));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { deleted: true }, error: null });
    expect(timeOff.map((t) => t.id)).not.toContain(MY_PTO);
    // That row and only that row.
    expect(timeOff.map((t) => t.id)).toContain(THEIR_PTO);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.user_id).toBe(ME);
  });

  it("serves an admin anyone's PTO, and the audit row names both people", async () => {
    signInAs(ADMIN, ORG_ADMIN);
    const res = await deleteRoute(plainReq, ctx(THEIR_PTO));
    expect(res.status).toBe(200);
    expect(timeOff.map((t) => t.id)).not.toContain(THEIR_PTO);
    expect(auditRows[0]!.user_id).toBe(ADMIN);
    expect(auditRows[0]!.payload.clinicianUserId).toBe(COLLEAGUE);
  });

  it("answers 404 for an id this tenant does not have", async () => {
    const res = await deleteRoute(plainReq, ctx(NO_SUCH_PTO));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found.");
    expect(auditRows).toHaveLength(0);
  });

  it("never reaches the table for a caller without schedule.edit", async () => {
    // The billing_agent template has no schedule.* at all. This pins the gate
    // as well as the guard: widening the route would be one way to "fix" the
    // ownership hole, and it would be the wrong one.
    signInAs(ADMIN, ROLE_DEFAULT_PERMISSIONS.billing_agent);
    const res = await deleteRoute(plainReq, ctx(THEIR_PTO));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(timeOff.map((t) => t.id)).toContain(THEIR_PTO);
  });
});

describe("POST /api/time-off — the real handler", () => {
  it("answers 403 when a clinician books onto a colleague's calendar", async () => {
    const res = await createRoute(jsonReq(bookingFor(COLLEAGUE)));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PTO_NOT_YOUR_CALENDAR);
    expect(inserts()).toHaveLength(0);
  });

  it("CONTROL: the same clinician books their own, and gets the id back", async () => {
    const res = await createRoute(jsonReq(bookingFor(ME)));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { id: NEW_PTO }, error: null });
    expect(timeOff.find((t) => t.id === NEW_PTO)?.clinician_user_id).toBe(ME);
  });

  it("lets an admin book for a colleague", async () => {
    signInAs(ADMIN, ORG_ADMIN);
    const res = await createRoute(jsonReq(bookingFor(COLLEAGUE)));
    expect(res.status).toBe(201);
    expect(timeOff.find((t) => t.id === NEW_PTO)?.clinician_user_id).toBe(COLLEAGUE);
  });

  it("still answers 422 for a non-member, with the message the composer shows", async () => {
    // The membership refusal predates this change and must keep its own
    // status: it is about what was sent, not about who sent it.
    signInAs(ADMIN, ORG_ADMIN);
    activeMembers = [ME, ADMIN];
    const res = await createRoute(jsonReq(bookingFor(COLLEAGUE)));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/is not an active member of this organization/);
    expect(inserts()).toHaveLength(0);
  });
});
