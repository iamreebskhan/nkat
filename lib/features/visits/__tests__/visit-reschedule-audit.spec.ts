/**
 * Moving a visit on the schedule leaves a record of who moved it.
 *
 * audit-write.ts declared "visit_reschedule" and nothing wrote it:
 * rescheduleVisit ran its UPDATE and returned, so a drag on /schedule changed
 * a visit's date of service with no row in audit_log (the local database had
 * none at all). Its UPDATE also matched on id and status alone, so on a
 * connection that bypasses RLS it moved another org's visit.
 *
 * rescheduleVisit is RUN here, as changeVisitType is in
 * visit-type-change.spec.ts: lib/db hands it sql-fake's transaction over
 * tables that hold two orgs with no RLS between them, and the audit row is
 * written by the real writeAudit into the same fake, so "one audit row" is
 * counted rather than assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { fakeTx, type FakeDb, type SqlRow } from "@/lib/features/team/__tests__/sql-fake";

import { rescheduleVisit } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
/** The clinician whose visit it is. */
const PRIYA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** The scheduler who drags it. */
const HELEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const VISIT = "e0000000-0000-4000-8000-00000000000a";

const created = new Date("2026-09-20T00:00:00.000Z");
const NEW_START = "2026-09-30T13:30:00.000Z";
/** NEW_START plus the visit's hour: it was 13:30–14:30 on the 29th. */
const NEW_END = "2026-09-30T14:30:00.000Z";

function visitRow(over: Partial<SqlRow> = {}): SqlRow {
  return {
    id: VISIT,
    org_id: ORG,
    patient_id: PATIENT,
    clinician_user_id: PRIYA,
    visit_type: "established_patient_home",
    scheduled_start: new Date("2026-09-29T13:30:00.000Z"),
    scheduled_end: new Date("2026-09-29T14:30:00.000Z"),
    start_time: null,
    stop_time: null,
    total_minutes: null,
    acp_minutes: 0,
    prolonged_minutes: 0,
    is_telehealth: false,
    telehealth_modality: null,
    telehealth_consent_documented: false,
    document_text: null,
    cpt_codes_assigned: [],
    cpt_units: {},
    icd10_codes: [],
    modifiers: [],
    status: "scheduled",
    signed_at: null,
    created_at: created,
    updated_at: created,
    place_of_service_code: "12",
    signed_by_user_id: null,
    signer_credential: null,
    note_template_id: null,
    ...over,
  };
}

let db: FakeDb;
let log: string[];
/** Set to make the audit INSERT fail, as a real one can (constraint, lost connection). */
let auditFailure: Error | null;

function load(visits: SqlRow[]): void {
  db = {
    visit: { columns: Object.keys(visitRow()), rows: visits },
    audit_log: {
      columns: ["org_id", "user_id", "action", "target_type", "target_id", "payload", "ip_address", "user_agent"],
      rows: [],
    },
  };
}

beforeEach(() => {
  load([visitRow()]);
  log = [];
  auditFailure = null;
  vi.mocked(withOrgContext).mockClear();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => {
    const tx = fakeTx(db, log);
    const wrapped = {
      ...tx,
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (auditFailure && /^\s*INSERT INTO audit_log\b/.test(strings[0] ?? "")) {
          return Promise.reject(auditFailure);
        }
        return tx.$executeRaw(strings, ...values);
      },
    };
    return (fn as (t: unknown) => Promise<unknown>)(wrapped);
  });
});

const row = () => db.visit!.rows.find((r) => r.id === VISIT)!;
const audits = () => db.audit_log!.rows;
const updates = () => log.filter((s) => /^UPDATE visit /i.test(s));
const move = () =>
  rescheduleVisit({ orgId: ORG, id: VISIT, scheduledStart: NEW_START, actorUserId: HELEN });

describe("rescheduleVisit — the move is audited", () => {
  it("writes one visit_reschedule row in the same transaction, naming fields and never the times", async () => {
    // And says where the visit went and whose it is, for the caller to move
    // the clinician's Google Calendar event with it.
    expect(await move()).toEqual({
      updated: true,
      moved: {
        clinicianUserId: PRIYA, patientId: PATIENT, visitType: "established_patient_home",
        start: NEW_START, end: NEW_END,
      },
    });
    // sql-fake strips the ::timestamptz cast, so the bind is stored as sent.
    expect(row().scheduled_start).toBe(NEW_START);
    expect(row().scheduled_end).toBe(NEW_END);
    expect((row().updated_at as Date).getTime()).toBeGreaterThan(created.getTime());

    expect(audits()).toHaveLength(1);
    const a = audits()[0]!;
    expect(a).toMatchObject({
      org_id: ORG,
      user_id: HELEN,
      action: "visit_reschedule",
      target_type: "visit",
      target_id: VISIT,
    });
    expect(JSON.parse(String(a.payload))).toEqual({ fields: ["scheduled_end", "scheduled_start"] });
    // A scheduled time is a date of service: it stays out of the trail.
    expect(String(a.payload)).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:/);
    // One transaction: the move and its row commit together or not at all.
    expect(vi.mocked(withOrgContext)).toHaveBeenCalledTimes(1);
    expect(log.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
      "SELECT scheduled_start, scheduled_end,",
      "UPDATE visit SET",
      "INSERT INTO audit_log",
    ]);
  });

  it("fails the move when its audit row cannot be written, so the transaction rolls it back", async () => {
    // Reviewed and kept: an unaudited change is not allowed through. The
    // UPDATE has already run in this transaction when the INSERT fails, so the
    // only thing standing between it and a commit is the error reaching
    // withOrgContext, which rolls back on a rejected callback.
    auditFailure = new Error("audit_log insert failed");
    await expect(move()).rejects.toThrow("audit_log insert failed");
    expect(updates()).toHaveLength(1);
    expect(vi.mocked(withOrgContext)).toHaveBeenCalledTimes(1);
  });

  it.each(["in_progress", "documented", "cancelled", "no_show"])(
    "CONTROL — a %s visit is not moved and not audited",
    async (status) => {
      load([visitRow({ status })]);
      const before = { ...row() };
      expect(await move()).toEqual({ updated: false });
      expect(row()).toEqual(before);
      expect(audits()).toEqual([]);
    },
  );

  it("neither moves nor audits a visit in another org", async () => {
    // What a connection that bypasses RLS sees: the id alone matched it.
    load([visitRow({ org_id: OTHER_ORG })]);
    const before = { ...row() };
    expect(await move()).toEqual({ updated: false });
    expect(row()).toEqual(before);
    expect(audits()).toEqual([]);
  });
});

/**
 * The schedule grid sends only the new start: a drag or a tap-to-move keeps
 * the time of day and changes the day. The route turned the missing end into
 * NULL and the UPDATE wrote it, so every move erased the visit's end. On the
 * local database, moving Loretta Simmons' 13:00–14:00 visit from Friday to
 * Thursday left it 13:00 to nothing.
 */
describe("rescheduleVisit — the visit keeps its length", () => {
  it("CONTROL — a move that sends only a start carries the end with it", async () => {
    await move();
    expect(row().scheduled_end).toBe(NEW_END);
  });

  it("keeps a 45-minute visit 45 minutes, so the length is the visit's own and not a default", async () => {
    load([visitRow({ scheduled_end: new Date("2026-09-29T14:15:00.000Z") })]);
    await move();
    expect(row().scheduled_end).toBe("2026-09-30T14:15:00.000Z");
  });

  it("leaves a visit with no end without one, and names only the start in the audit row", async () => {
    load([visitRow({ scheduled_end: null })]);
    expect(await move()).toMatchObject({ updated: true, moved: { start: NEW_START, end: null } });
    expect(row().scheduled_start).toBe(NEW_START);
    expect(row().scheduled_end).toBeNull();
    expect(JSON.parse(String(audits()[0]!.payload))).toEqual({ fields: ["scheduled_start"] });
  });

  it("writes an end that is sent with the start as sent", async () => {
    const end = "2026-09-30T15:00:00.000Z";
    await rescheduleVisit({
      orgId: ORG, id: VISIT, scheduledStart: NEW_START, scheduledEnd: end, actorUserId: HELEN,
    });
    expect(row().scheduled_end).toBe(end);
  });

  it("clears the end when null is sent for it", async () => {
    await rescheduleVisit({
      orgId: ORG, id: VISIT, scheduledStart: NEW_START, scheduledEnd: null, actorUserId: HELEN,
    });
    expect(row().scheduled_start).toBe(NEW_START);
    expect(row().scheduled_end).toBeNull();
  });

  it.each([
    ["at", NEW_START],
    ["before", "2026-09-30T13:00:00.000Z"],
  ])("refuses an end %s the new start, and neither moves nor audits the visit", async (_w, end) => {
    const before = { ...row() };
    await expect(
      rescheduleVisit({
        orgId: ORG, id: VISIT, scheduledStart: NEW_START, scheduledEnd: end, actorUserId: HELEN,
      }),
    ).rejects.toThrow("The end time must be after the start time.");
    expect(row()).toEqual(before);
    expect(updates()).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("writes nothing and records nothing when the visit is put back where it already is", async () => {
    // Tapping Move and then the visit's own day sends the start it already has.
    const before = { ...row() };
    expect(
      await rescheduleVisit({
        orgId: ORG, id: VISIT, scheduledStart: "2026-09-29T13:30:00.000Z", actorUserId: HELEN,
      }),
    ).toEqual({ updated: true }); // and no `moved`: there is no event to move
    expect(row()).toEqual(before);
    expect(updates()).toEqual([]);
    expect(audits()).toEqual([]);
  });
});
