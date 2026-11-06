/**
 * scheduleVisit must refuse a clinician who is not an active member of the
 * booking org.
 *
 * visit.clinician_user_id is a bare FK to app_user, which is global and has
 * no RLS, so the database accepts any user id at all. The /schedule picker
 * only lists active members, but the picker is not the server: a direct POST
 * to /api/visits could put a removed member on the calendar — a visit nobody
 * can open — or a user id belonging to ANOTHER ORG, which then appears on
 * this org's schedule under a stranger's name.
 *
 * These run the real scheduleVisit against a fake tx that models org_member
 * as rows of (org_id, user_id, status), so the guard's org_id and
 * status = 'active' predicates both have to be there for the refusals to
 * happen — and every refusal asserts that NOTHING was inserted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { scheduleVisit } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "aaaa1111-1111-4111-8111-111111111111";
const VISIT = "22222222-2222-4222-8222-222222222222";
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

/** One patient per org. Each booking below names its own org's patient. */
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "f0000000-0000-4000-8000-000000000002";
/** ORG's patients no longer under care (0115). */
const DISCHARGED = "f0000000-0000-4000-8000-000000000003";
const DIED = "f0000000-0000-4000-8000-000000000004";
const ARCHIVED = "f0000000-0000-4000-8000-000000000005";
const PATIENTS: { org_id: string; id: string; status: string }[] = [
  { org_id: ORG, id: PATIENT, status: "active" },
  { org_id: OTHER_ORG, id: OTHER_PATIENT, status: "active" },
  { org_id: ORG, id: DISCHARGED, status: "discharged" },
  { org_id: ORG, id: DIED, status: "deceased" },
  { org_id: ORG, id: ARCHIVED, status: "archived" },
];

let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM org_visit_type")) {
      return Promise.resolve([{ slug: values[1], is_telehealth: false }]);
    }
    // scheduleVisit's patient guard. Bindings are (org_id, patient_id).
    if (sql.includes("FROM patient")) {
      const hit = PATIENTS.find((p) => p.org_id === values[0] && p.id === values[1]);
      return Promise.resolve(hit ? [{ status: hit.status }] : []);
    }
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
    if (sql.includes("INSERT INTO visit")) return Promise.resolve([{ id: VISIT }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const payloadFor = (clinicianUserId: string, patientId: string = PATIENT) => ({
  patientId,
  clinicianUserId,
  visitType: "established_patient_home",
  scheduledStart: "2026-09-20T15:00:00Z",
  isTelehealth: false,
});

const inserted = () => calls.filter((c) => c.sql.includes("INSERT INTO visit"));

describe("scheduleVisit — the clinician must be an active member of this org", () => {
  for (const [label, userId] of [
    ["a removed member", REMOVED],
    ["a suspended member", SUSPENDED],
    ["an invited member who never joined", INVITED],
    ["an active member of another org", STRANGER],
    ["a user id with no membership anywhere", NOBODY],
  ] as const) {
    it(`refuses ${label}, and writes no visit`, async () => {
      await expect(scheduleVisit({ orgId: ORG, actorUserId: null, payload: payloadFor(userId) })).rejects.toThrow(
        /is not an active member of this organization/,
      );
      expect(inserted()).toHaveLength(0);
    });
  }

  it("refuses with a 422 ValidationError naming the id and what to do instead", async () => {
    const err = await scheduleVisit({ orgId: ORG, actorUserId: null, payload: payloadFor(REMOVED) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(REMOVED);
    expect((err as Error).message).toMatch(/Pick someone from the Clinician list\./);
  });

  it("asks org_member about THIS org and THIS clinician", async () => {
    await scheduleVisit({ orgId: ORG, actorUserId: null, payload: payloadFor(ACTIVE) });
    const q = calls.find((c) => c.sql.includes("FROM org_member"));
    expect(q).toBeDefined();
    expect(q!.values[0]).toBe(ORG);
    expect(q!.values[1]).toBe(ACTIVE);
    expect(q!.sql).toContain("status = 'active'");
  });

  it("CONTROL: an active member is booked normally", async () => {
    const r = await scheduleVisit({ orgId: ORG, actorUserId: null, payload: payloadFor(ACTIVE) });
    expect(r).toEqual({ id: VISIT });
    expect(inserted()).toHaveLength(1);
    expect(inserted()[0]!.values).toContain(ACTIVE);
  });

  it("CONTROL: the same stranger books fine in the org they actually belong to", async () => {
    // Proves the refusal is about membership in the BOOKING org, not about
    // this particular user id being blacklisted.
    const r = await scheduleVisit({
      orgId: OTHER_ORG,
      actorUserId: null,
      payload: payloadFor(STRANGER, OTHER_PATIENT),
    });
    expect(r).toEqual({ id: VISIT });
    expect(inserted()).toHaveLength(1);
  });
});

describe("scheduleVisit — the patient must be under care (0115)", () => {
  for (const [label, patientId, message] of [
    ["a discharged patient", DISCHARGED, /discharged\. Readmit them/],
    ["a patient who has died", DIED, /has died\. Only a bereavement follow-up/],
    ["an archived chart", ARCHIVED, /archived\. Restore it/],
  ] as const) {
    it(`refuses ${label}, and writes no visit`, async () => {
      await expect(scheduleVisit({ orgId: ORG, actorUserId: null, payload: payloadFor(ACTIVE, patientId) })).rejects.toThrow(message);
      expect(inserted()).toHaveLength(0);
    });
  }

  it("still books the family's bereavement follow-up after a death, and nothing else then", async () => {
    const r = await scheduleVisit({ orgId: ORG, actorUserId: null, payload: { ...payloadFor(ACTIVE, DIED), visitType: "bereavement_follow_up" } });
    expect(r).toEqual({ id: VISIT });
    // CONTROL: the bereavement type does not reopen a discharged patient.
    await expect(
      scheduleVisit({ orgId: ORG, actorUserId: null, payload: { ...payloadFor(ACTIVE, DISCHARGED), visitType: "bereavement_follow_up" } }),
    ).rejects.toThrow(/discharged/);
    expect(inserted()).toHaveLength(1);
  });
});

describe("scheduleVisit — the booking is audited", () => {
  /** Who booked it: the scheduler, not the clinician the visit is for. */
  const HELEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const audits = () => calls.filter((c) => /^\s*INSERT INTO audit_log\b/.test(c.sql));

  it("writes one visit_create row naming who booked it and the visit, never the time", async () => {
    const r = await scheduleVisit({ orgId: ORG, actorUserId: HELEN, payload: payloadFor(ACTIVE) });
    expect(audits()).toHaveLength(1);
    // writeAudit binds org, user, action, target type, target id, payload, ip, agent.
    const [org, user, action, targetType, targetId, payload] = audits()[0]!.values;
    expect([org, user, action, targetType, targetId]).toEqual([ORG, HELEN, "visit_create", "visit", r.id]);
    expect(JSON.parse(payload as string)).toEqual({ telehealth: false });
    expect(payload).not.toContain("2026-09-20");
    // After the visit exists, in the same transaction.
    const order = calls.map((c) => (c.sql.includes("INSERT INTO visit") ? "visit" : /INSERT INTO audit_log/.test(c.sql) ? "audit" : null)).filter(Boolean);
    expect(order).toEqual(["visit", "audit"]);
  });

  it("writes nothing when the booking is refused", async () => {
    await expect(scheduleVisit({ orgId: ORG, actorUserId: HELEN, payload: payloadFor(REMOVED) })).rejects.toThrow();
    expect(audits()).toHaveLength(0);
  });

  it("a failed audit write fails the booking (the transaction rolls the visit back)", async () => {
    vi.mocked(withOrgContext).mockImplementationOnce(async (_orgId, fn) => {
      const tx = fakeTx();
      const failing = {
        ...tx,
        $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
          /INSERT INTO audit_log/.test(strings.join("")) ? Promise.reject(new Error("audit down")) : tx.$executeRaw(strings, ...values),
      };
      return (fn as (t: unknown) => Promise<unknown>)(failing);
    });
    await expect(scheduleVisit({ orgId: ORG, actorUserId: HELEN, payload: payloadFor(ACTIVE) })).rejects.toThrow("audit down");
  });
});
