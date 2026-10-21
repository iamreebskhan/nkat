/**
 * Correcting a visit's type before it is signed.
 *
 * The scheduler used to start every new visit on the established-patient type,
 * and nothing could change visit_type after scheduling: documentVisit never
 * writes it, /api/visits/[id] had GET only, and the document screen told the
 * clinician to "pick a visit type" with nowhere to pick one. A first visit left
 * on the default was coded 99347-99350 instead of 99341-99345, and the only fix
 * left was a code override on the bill after signing.
 *
 * changeVisitType is RUN here: lib/db hands it sql-fake's transaction, the
 * tables hold two orgs with no RLS between them (what the preview's superuser
 * connection sees), and the audit row is written by the real writeAudit into
 * the same fake, so "one audit row" is counted rather than assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { fakeTx, type FakeDb, type SqlRow } from "@/lib/features/team/__tests__/sql-fake";

import { buildBands, suggestCodes, type VisitCodeBands } from "../cpt-suggester";
import { changeVisitType, getVisit, listVisits } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const TEMPLATE = "70000000-0000-4000-8000-000000000001";

/** The ladders from code.typical_minutes, built the way /api/billing/code-bands builds them. */
const BANDS: VisitCodeBands = {
  newPatientHome: buildBands([
    { code: "99341", typicalMinutes: 15 },
    { code: "99342", typicalMinutes: 30 },
    { code: "99344", typicalMinutes: 60 },
    { code: "99345", typicalMinutes: 75 },
  ]),
  establishedPatientHome: buildBands([
    { code: "99347", typicalMinutes: 20 },
    { code: "99348", typicalMinutes: 30 },
    { code: "99349", typicalMinutes: 40 },
    { code: "99350", typicalMinutes: 60 },
  ]),
};

const type = (org_id: string, slug: string, label: string, coding_basis: string, extra: Partial<SqlRow> = {}): SqlRow => ({
  org_id, slug, label, coding_basis, is_telehealth: false, active: true, ...extra,
});

/**
 * The OTHER_ORG row for the shared slug comes FIRST, so a join that forgets the
 * org reads it before this org's own row.
 */
function types(): SqlRow[] {
  return [
    type(OTHER_ORG, "bereavement_follow_up", "Bereavement (other org)", "established_patient_home"),
    type(OTHER_ORG, "other_org_only", "Only in the other org", "new_patient_home"),
    type(ORG, "new_patient_home", "New patient — home", "new_patient_home"),
    type(ORG, "established_patient_home", "Established patient — home", "established_patient_home"),
    type(ORG, "advance_care_planning", "Advance care planning", "advance_care_planning"),
    type(ORG, "telehealth", "Established patient — telehealth", "established_patient_home", { is_telehealth: true }),
    type(ORG, "long_established_home", "Established — long home visit", "established_patient_home"),
    type(ORG, "bereavement_follow_up", "Bereavement follow-up", "non_billable"),
    type(ORG, "retired_new_type", "Retired new-patient type", "new_patient_home", { active: false }),
    type(ORG, "retired_established", "Retired established type", "established_patient_home", { active: false }),
  ];
}

const created = new Date("2026-09-20T00:00:00.000Z");

function visitRow(over: Partial<SqlRow> = {}): SqlRow {
  return {
    id: VISIT,
    org_id: ORG,
    patient_id: PATIENT,
    clinician_user_id: ME,
    visit_type: "established_patient_home",
    scheduled_start: new Date("2026-09-25T14:00:00.000Z"),
    scheduled_end: null,
    start_time: new Date("2026-09-25T14:00:00.000Z"),
    stop_time: new Date("2026-09-25T14:45:00.000Z"),
    total_minutes: 45,
    acp_minutes: 0,
    prolonged_minutes: 0,
    is_telehealth: false,
    telehealth_modality: null,
    telehealth_consent_documented: false,
    document_text: null,
    cpt_codes_assigned: ["99349"],
    cpt_units: {},
    icd10_codes: ["C34.90"],
    modifiers: [],
    status: "in_progress",
    signed_at: null,
    created_at: created,
    updated_at: created,
    place_of_service_code: "12",
    signed_by_user_id: null,
    signer_credential: null,
    note_template_id: TEMPLATE,
    ...over,
  };
}

let db: FakeDb;
let log: string[];
/** Runs just before the service's UPDATE of visit, for the race case. */
let beforeUpdate: (() => void) | null;
/** Set to make the audit INSERT fail, as a real one can (constraint, lost connection). */
let auditFailure: Error | null;

function load(visits: SqlRow[]): void {
  db = {
    visit: { columns: Object.keys(visitRow()), rows: visits },
    org_visit_type: { columns: ["org_id", "slug", "label", "coding_basis", "is_telehealth", "active"], rows: types() },
    app_user: { columns: ["id", "full_name"], rows: [{ id: ME, full_name: "Priya Raman" }] },
    patient: {
      columns: ["id", "org_id", "first_name", "last_name", "city"],
      rows: [{ id: PATIENT, org_id: ORG, first_name: "Test", last_name: "Visittype", city: "Tampa" }],
    },
    // getVisit and listVisits join the org's zone for serviceDay (0107).
    org: { columns: ["id", "timezone"], rows: [{ id: ORG, timezone: "America/New_York" }] },
    audit_log: {
      columns: ["org_id", "user_id", "action", "target_type", "target_id", "payload", "ip_address", "user_agent"],
      rows: [],
    },
  };
}

beforeEach(() => {
  load([visitRow()]);
  log = [];
  beforeUpdate = null;
  auditFailure = null;
  vi.mocked(withOrgContext).mockClear();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => {
    const tx = fakeTx(db, log);
    const wrapped = {
      ...tx,
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (/^\s*UPDATE visit\b/.test(strings[0] ?? "")) beforeUpdate?.();
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
const change = (visitType: string) => changeVisitType({ orgId: ORG, id: VISIT, visitType, actorUserId: ME });

async function codesFor(minutes: number): Promise<string[]> {
  const v = (await getVisit({ orgId: ORG, id: VISIT }))!;
  const s = suggestCodes({ bands: BANDS, visitType: v.codingBasis, totalMinutes: minutes, payerCategory: "medicare" });
  return s.base.map((c) => c.code);
}

describe("changeVisitType — the correction path", () => {
  it("moves a first visit left on the established default onto the new-patient ladder", async () => {
    // The defect as it reaches the bill: 45 minutes on the default type.
    expect(await codesFor(45)).toEqual(["99349"]);

    const r = await change("new_patient_home");
    expect(r).toEqual({
      changed: true,
      codesCleared: true,
      fromBasis: "established_patient_home",
      toBasis: "new_patient_home",
    });

    const v = (await getVisit({ orgId: ORG, id: VISIT }))!;
    expect(v.visitType).toBe("new_patient_home");
    expect(v.codingBasis).toBe("new_patient_home");
    expect(v.visitTypeLabel).toBe("New patient — home");
    expect(await codesFor(45)).toEqual(["99342"]);
    expect(await codesFor(60)).toEqual(["99344"]);
    // The codes saved under the old band are cleared, units with them, so the
    // next save writes the new ladder's code rather than a stale 99349.
    expect(row().cpt_codes_assigned).toEqual([]);
    // sql-fake stores a ::jsonb bind as the text it was sent; Postgres parses it.
    expect(row().cpt_units).toBe("{}");
    expect(row().updated_at).toBeInstanceOf(Date);
    expect(row().status).toBe("in_progress");
    // An in-person visit moved to an in-person type stays in person: no
    // modifier 95, no place of service 10, no consent asked for at sign-off.
    expect(row()).toMatchObject({ is_telehealth: false, telehealth_modality: null });
  });

  it("writes exactly one audit row, in the same transaction, carrying closed-set bands only", async () => {
    await change("new_patient_home");
    expect(audits()).toHaveLength(1);
    const a = audits()[0]!;
    expect(a).toMatchObject({ org_id: ORG, user_id: ME, action: "visit_type_change", target_type: "visit", target_id: VISIT });
    const payload = JSON.parse(String(a.payload)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["codesCleared", "fromBasis", "toBasis"]);
    expect(payload).toEqual({ fromBasis: "established_patient_home", toBasis: "new_patient_home", codesCleared: true });
  });

  it("fails the change when its audit row cannot be written, so the transaction rolls the change back", async () => {
    // Reviewed and kept: an unaudited correction is not allowed through. The
    // UPDATE has already run in this transaction when the INSERT fails, so the
    // only thing standing between it and a commit is the error reaching
    // withOrgContext, which rolls back on a rejected callback.
    auditFailure = new Error("audit_log insert failed");
    await expect(change("new_patient_home")).rejects.toThrow("audit_log insert failed");
    expect(updates()).toHaveLength(1);
    expect(vi.mocked(withOrgContext)).toHaveBeenCalledTimes(1);
  });

  it("changes a visit that is still only scheduled, and leaves it scheduled", async () => {
    load([visitRow({ status: "scheduled", start_time: null, stop_time: null, total_minutes: null, cpt_codes_assigned: [] })]);
    expect((await change("new_patient_home")).changed).toBe(true);
    expect(row()).toMatchObject({ visit_type: "new_patient_home", status: "scheduled" });
  });

  it.each(["documented", "pending_billing", "billed"])("refuses a %s visit: signed is attested", async (status) => {
    load([visitRow({ status })]);
    const before = { ...row() };
    await expect(change("new_patient_home")).rejects.toThrow(/signed/);
    expect(row()).toEqual(before);
    expect(updates()).toEqual([]);
    expect(audits()).toHaveLength(0);
  });

  it("gives a signed visit the signed message even when the slug asked for is not a type at all", async () => {
    load([visitRow({ status: "documented" })]);
    await expect(change("no_such_type")).rejects.toThrow(/signed/);
  });

  it.each(["cancelled", "no_show"])("refuses a %s visit", async (status) => {
    load([visitRow({ status })]);
    await expect(change("new_patient_home")).rejects.toThrow(/cannot be changed/);
    expect(row().visit_type).toBe("established_patient_home");
    expect(audits()).toHaveLength(0);
  });

  it("writes nothing when the visit is signed between the read and the write", async () => {
    // Two actors on one visit: the sign-off commits after changeVisitType has
    // read an open visit and before its UPDATE. The UPDATE's own status
    // predicate is what stops it.
    beforeUpdate = () => {
      row().status = "documented";
    };
    await expect(change("new_patient_home")).rejects.toThrow(/signed while/);
    expect(row()).toMatchObject({ visit_type: "established_patient_home", cpt_codes_assigned: ["99349"] });
    expect(audits()).toHaveLength(0);
  });

  it.each([
    ["an unknown slug", "no_such_type"],
    ["an inactive type of this org", "retired_new_type"],
    ["a type that exists only in another org", "other_org_only"],
  ])("refuses %s, and writes nothing", async (_what, slug) => {
    await expect(change(slug)).rejects.toThrow(/not one of your visit types/);
    expect(row().visit_type).toBe("established_patient_home");
    expect(updates()).toEqual([]);
    expect(audits()).toHaveLength(0);
  });

  it("a telehealth type makes the visit telehealth, audio and video unless a modality is already set", async () => {
    expect((await change("telehealth")).codesCleared).toBe(false);
    expect(row()).toMatchObject({ visit_type: "telehealth", is_telehealth: true, telehealth_modality: "audio_video" });
  });

  it("CONTROL — a modality already recorded is kept", async () => {
    load([visitRow({ is_telehealth: true, telehealth_modality: "audio_only" })]);
    await change("telehealth");
    expect(row()).toMatchObject({ is_telehealth: true, telehealth_modality: "audio_only" });
  });

  it("leaving a telehealth type does not untick telehealth: that is the clinician's call", async () => {
    load([visitRow({ visit_type: "telehealth", is_telehealth: true, telehealth_modality: "audio_video" })]);
    await change("new_patient_home");
    expect(row()).toMatchObject({ visit_type: "new_patient_home", is_telehealth: true, telehealth_modality: "audio_video" });
  });

  it("keeps the codes when the band does not change", async () => {
    const r = await change("long_established_home");
    expect(r).toEqual({
      changed: true,
      codesCleared: false,
      fromBasis: "established_patient_home",
      toBasis: "established_patient_home",
    });
    expect(row().cpt_codes_assigned).toEqual(["99349"]);
    expect(row().cpt_units).toEqual({});
    expect(JSON.parse(String(audits()[0]!.payload))).toEqual({
      fromBasis: "established_patient_home",
      toBasis: "established_patient_home",
      codesCleared: false,
    });
  });

  it("does nothing for the slug the visit already has, even one since deactivated", async () => {
    expect(await change("established_patient_home")).toEqual({
      changed: false,
      codesCleared: false,
      fromBasis: "established_patient_home",
      toBasis: "established_patient_home",
    });
    expect(updates()).toEqual([]);
    expect(audits()).toHaveLength(0);
    // A type switched off after this visit was booked is still the visit's own:
    // re-saving it is a no-op, not "not one of your visit types".
    load([visitRow({ visit_type: "retired_established" })]);
    expect((await change("retired_established")).changed).toBe(false);
    expect(updates()).toEqual([]);
    expect(audits()).toHaveLength(0);
    expect(row().cpt_codes_assigned).toEqual(["99349"]);
  });

  it("reads a current slug with no type row as established, so the audit band stays in the closed set", async () => {
    load([visitRow({ visit_type: "pre_0062_slug" })]);
    const r = await change("new_patient_home");
    expect(r.fromBasis).toBe("established_patient_home");
    expect(JSON.parse(String(audits()[0]!.payload)).fromBasis).toBe("established_patient_home");
  });

  it("reads the band being left from this org's own type, for a slug another org bills differently", async () => {
    // bereavement_follow_up is not billed here and established in the other
    // org, whose row comes first. Read on the slug alone, the visit would seem
    // to be leaving the established band: no codes cleared, and an audit row
    // recording a band it never had.
    load([visitRow({ visit_type: "bereavement_follow_up" })]);
    expect(await change("established_patient_home")).toEqual({
      changed: true,
      codesCleared: true,
      fromBasis: "non_billable",
      toBasis: "established_patient_home",
    });
    expect(row()).toMatchObject({ visit_type: "established_patient_home", cpt_codes_assigned: [] });
    expect(JSON.parse(String(audits()[0]!.payload))).toEqual({
      fromBasis: "non_billable",
      toBasis: "established_patient_home",
      codesCleared: true,
    });
  });

  it("never touches the note-template pin, the times, the diagnoses, the modifiers, the place of service or telehealth", async () => {
    const before = { ...row() };
    await change("new_patient_home");
    for (const col of [
      "note_template_id", "start_time", "stop_time", "total_minutes", "acp_minutes",
      "icd10_codes", "modifiers", "place_of_service_code", "status", "clinician_user_id",
      "is_telehealth", "telehealth_modality",
    ]) {
      expect(row()[col], col).toEqual(before[col]);
    }
  });

  it("answers Visit not found for a visit in another org", async () => {
    load([visitRow({ org_id: OTHER_ORG })]);
    await expect(change("new_patient_home")).rejects.toThrow("Visit not found.");
    expect(row().visit_type).toBe("established_patient_home");
  });
});

describe("getVisit and listVisits — the type join is scoped to the visit's own org", () => {
  it("reads this org's band and label for a slug both orgs use", async () => {
    // bereavement_follow_up is non_billable here and established in the other
    // org — the collision the real database has between Design Partner and
    // Demo Org. A join on slug alone read the other org's row.
    load([visitRow({ visit_type: "bereavement_follow_up" })]);
    const v = (await getVisit({ orgId: ORG, id: VISIT }))!;
    expect(v.codingBasis).toBe("non_billable");
    expect(v.visitTypeLabel).toBe("Bereavement follow-up");
  });

  it("listVisits reads the same: one row per visit, with this org's band and label", async () => {
    // A join on the slug alone matched both orgs' rows, so the visit came back
    // twice — the other org's band first.
    load([visitRow({ visit_type: "bereavement_follow_up" })]);
    const rows = await listVisits({ orgId: ORG, patientId: PATIENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: VISIT,
      codingBasis: "non_billable",
      visitTypeLabel: "Bereavement follow-up",
      patientName: "Test Visittype",
      clinicianName: "Priya Raman",
    });
  });
});

/**
 * serviceDay: the visit's day where the practice is (0107). The patient page
 * and the claims queue sliced the instant's UTC day, so on localhost Shirley
 * Tanaka's 8:30 pm EDT visit on 22 Sep was listed on the 23rd.
 */
describe("getVisit and listVisits — the visit's day where the practice is", () => {
  it("dates an 8:30 pm EDT visit on its Ohio day", async () => {
    load([visitRow({ start_time: new Date("2026-09-23T00:30:00Z"), scheduled_start: new Date("2026-09-22T18:00:00Z") })]);
    expect((await getVisit({ orgId: ORG, id: VISIT }))!.serviceDay).toBe("2026-09-22");
    expect((await listVisits({ orgId: ORG, patientId: PATIENT }))[0]!.serviceDay).toBe("2026-09-22");
  });

  it("uses the scheduled start for a visit not yet started", async () => {
    load([visitRow({ start_time: null, scheduled_start: new Date("2026-10-30T01:00:00Z") })]);
    expect((await getVisit({ orgId: ORG, id: VISIT }))!.serviceDay).toBe("2026-10-29");
  });

  it("follows the org's own zone", async () => {
    load([visitRow({ start_time: new Date("2026-09-23T04:30:00Z") })]);
    db.org!.rows[0]!.timezone = "America/Chicago";
    expect((await getVisit({ orgId: ORG, id: VISIT }))!.serviceDay).toBe("2026-09-22");
    db.org!.rows[0]!.timezone = "America/New_York";
    expect((await getVisit({ orgId: ORG, id: VISIT }))!.serviceDay).toBe("2026-09-23");
  });

  it("is null for a visit with no time at all", async () => {
    load([visitRow({ start_time: null, scheduled_start: null })]);
    expect((await getVisit({ orgId: ORG, id: VISIT }))!.serviceDay).toBeNull();
  });
});
