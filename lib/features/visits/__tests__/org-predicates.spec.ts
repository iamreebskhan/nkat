/**
 * Every visit, visit-type and visit-service statement names its org.
 *
 * RLS keeps the orgs apart on the `app` role and stays the primary control.
 * These statements leaned on it alone: getVisit and requireVisitAccess read a
 * visit by id, listVisits and the GET /api/visits count had no org predicate
 * and joined the patient by id, scheduleVisit looked its type up by slug, the
 * type and service catalogs counted usage across every org, and the writes
 * behind them (transition, document, the type and service edits) matched on id
 * alone. On a connection that bypasses RLS, which is what the preview's
 * superuser connection is, each one read or wrote another org's row.
 *
 * One gap is real on `app` as well: visit_patient_id_fkey is id-only, a
 * foreign-key check skips row security, and visit has no trigger, so
 * scheduleVisit booked another org's patient.
 *
 * The services run for real. lib/db hands them sql-fake's evaluator over
 * tables that hold two orgs with no RLS, OTHER_ORG's rows first, so a
 * statement that forgets its org meets the other org's row before its own.
 * The transaction below rewrites only what sql-fake cannot model and hands the
 * rest, the org predicate always included, to sql-fake with the binds the
 * service sent, so every predicate is judged by the evaluator and none by
 * looking at the values bound:
 *   - transitionVisit's read keeps its FROM … WHERE tail; its select list of
 *     subqueries becomes the columns a cancel reads;
 *   - lower(x) becomes x (the fixtures are lowercase);
 *   - NOT IN over two literals becomes two <>, and the capacity count's
 *     comparison of the two practice days becomes true (every fixture is on
 *     the one day; which day is which is capacity-day.spec.ts's question);
 *   - COALESCE((SELECT MAX(sort_order) + 10 FROM t …), 100) is worked out by
 *     running SELECT sort_order FROM t … through sql-fake, same binds;
 *   - INSERT … RETURNING id is given an id column, and ON CONFLICT … DO UPDATE
 *     is dropped (setVisitServices has just DELETEd the set it rewrites).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/features/calendar/google-calendar.service", () => ({
  getBusyForClinician: vi.fn().mockResolvedValue([]),
  pushVisitToGoogle: vi.fn().mockResolvedValue(undefined),
}));

import { type NextRequest } from "next/server";

import { NotFoundError, ValidationError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import { prepare, run, type FakeDb, type SqlRow } from "@/lib/features/team/__tests__/sql-fake";

import { GET as visitsGet } from "@/app/api/visits/route";

import { requireVisitAccess } from "../visit-access";
import {
  createService,
  listServiceCatalog,
  listVisitServices,
  setVisitServices,
  updateService,
} from "../visit-services.service";
import { createVisitType, listVisitTypes, updateVisitType } from "../visit-types.service";
import {
  documentVisit,
  getDailyCapacityStatus,
  getVisit,
  listVisits,
  scheduleVisit,
  transitionVisit,
} from "../visit.service";
import type { ScheduleVisit } from "../visit.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
/** Active in both orgs, so a statement that forgets its org finds their visits twice. */
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLLEAGUE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "f0000000-0000-4000-8000-000000000002";

/** OTHER_ORG's visits. Two of them are ME's. */
const FOREIGN = "e0000000-0000-4000-8000-0000000000f1";
const FOREIGN_IN_PROGRESS = "e0000000-0000-4000-8000-0000000000f2";
const FOREIGN_STRANGER = "e0000000-0000-4000-8000-0000000000f3";
/** ORG's visits. */
const MINE = "e0000000-0000-4000-8000-000000000001";
const MINE_VIDEO = "e0000000-0000-4000-8000-000000000002";
const MINE_CANCELLED = "e0000000-0000-4000-8000-000000000003";
const COLLEAGUES = "e0000000-0000-4000-8000-000000000004";
/**
 * An ORG visit booked on OTHER_ORG's patient. Creatable as `app` until the
 * patient guard: the foreign-key check that let it in skips row security.
 */
const CROSS_PATIENT = "e0000000-0000-4000-8000-000000000005";
const ORG_VISITS = [MINE, MINE_VIDEO, MINE_CANCELLED, COLLEAGUES, CROSS_PATIENT];

const T_OTHER_ONLY = "70000000-0000-4000-8000-0000000000f1";
const T_OTHER_VIDEO = "70000000-0000-4000-8000-0000000000f2";
const T_OTHER_BEREAVEMENT = "70000000-0000-4000-8000-0000000000f3";
const T_EST = "70000000-0000-4000-8000-000000000001";
const T_VIDEO = "70000000-0000-4000-8000-000000000002";
const T_BEREAVEMENT = "70000000-0000-4000-8000-000000000003";
const T_RETIRED = "70000000-0000-4000-8000-000000000004";

const S_OTHER_ONLY = "50000000-0000-4000-8000-0000000000f1";
const S_OTHER_SHARED = "50000000-0000-4000-8000-0000000000f2";
const S_SYMPTOM = "50000000-0000-4000-8000-000000000001";
const S_WOUND = "50000000-0000-4000-8000-000000000002";

/** Every visit is on this one day, so the capacity count's date() can be read as true. */
const at = (hour: number) => new Date(`2026-09-25T${String(hour).padStart(2, "0")}:00:00.000Z`);
const created = new Date("2026-09-20T00:00:00.000Z");

function visit(id: string, org_id: string, over: Partial<SqlRow> = {}): SqlRow {
  return {
    id,
    org_id,
    patient_id: org_id === ORG ? PATIENT : OTHER_PATIENT,
    clinician_user_id: ME,
    visit_type: "established_patient_home",
    scheduled_start: at(9),
    scheduled_end: null,
    start_time: null,
    stop_time: null,
    total_minutes: null,
    acp_minutes: 0,
    prolonged_minutes: 0,
    is_telehealth: false,
    telehealth_modality: null,
    telehealth_consent_documented: false,
    document_text: null,
    note_template_id: null,
    cpt_codes_assigned: [],
    cpt_units: {},
    icd10_codes: [],
    modifiers: [],
    status: "scheduled",
    signed_at: null,
    signed_by_user_id: null,
    signer_credential: null,
    place_of_service_code: null,
    created_at: created,
    updated_at: created,
    ...over,
  };
}

const visitType = (
  id: string,
  org_id: string,
  slug: string,
  label: string,
  coding_basis: string,
  sort_order: number,
  over: Partial<SqlRow> = {},
): SqlRow => ({
  id, org_id, slug, label, coding_basis, is_telehealth: false, active: true, sort_order,
  updated_at: created, ...over,
});

const service = (id: string, org_id: string, name: string, sort_order: number): SqlRow => ({
  id, org_id, name, description: null, category: "clinical", cpt_hint: null, active: true,
  sort_order, visit_types: [], updated_at: created,
});

const provided = (visit_id: string, service_id: string, org_id: string): SqlRow => ({
  visit_id, service_id, org_id, minutes: 15, note: null,
});

function load(): FakeDb {
  const visits = [
    visit(FOREIGN, OTHER_ORG, { visit_type: "video_visit" }),
    visit(FOREIGN_IN_PROGRESS, OTHER_ORG, {
      visit_type: "bereavement_follow_up", status: "in_progress", scheduled_start: at(10), start_time: at(10),
    }),
    visit(FOREIGN_STRANGER, OTHER_ORG, { clinician_user_id: STRANGER, visit_type: "video_visit", scheduled_start: at(11) }),
    visit(MINE, ORG, { scheduled_start: at(13) }),
    visit(MINE_VIDEO, ORG, {
      visit_type: "video_visit", status: "in_progress", scheduled_start: at(14), start_time: at(14),
      is_telehealth: true, telehealth_modality: "audio_video",
    }),
    visit(MINE_CANCELLED, ORG, { status: "cancelled", scheduled_start: at(15) }),
    visit(COLLEAGUES, ORG, { clinician_user_id: COLLEAGUE, scheduled_start: at(16) }),
    visit(CROSS_PATIENT, ORG, { clinician_user_id: COLLEAGUE, patient_id: OTHER_PATIENT, scheduled_start: at(17) }),
  ];
  return {
    visit: { columns: Object.keys(visits[0]!), rows: visits },
    // The other org's rows first. video_visit and bereavement_follow_up exist
    // in both orgs, differently: the other org's video visit is in person and
    // its bereavement visit is billed.
    org_visit_type: {
      columns: Object.keys(visitType(T_EST, ORG, "x", "x", "x", 0)),
      rows: [
        visitType(T_OTHER_ONLY, OTHER_ORG, "other_org_only", "Only in the other org", "new_patient_home", 900),
        visitType(T_OTHER_VIDEO, OTHER_ORG, "video_visit", "Video (other org)", "established_patient_home", 910),
        visitType(T_OTHER_BEREAVEMENT, OTHER_ORG, "bereavement_follow_up", "Bereavement (other org)", "established_patient_home", 920),
        visitType(T_EST, ORG, "established_patient_home", "Established patient — home", "established_patient_home", 10),
        visitType(T_VIDEO, ORG, "video_visit", "Video visit", "established_patient_home", 20, { is_telehealth: true }),
        visitType(T_BEREAVEMENT, ORG, "bereavement_follow_up", "Bereavement follow-up", "non_billable", 30),
        visitType(T_RETIRED, ORG, "retired_type", "Retired type", "new_patient_home", 40, { active: false }),
      ],
    },
    patient: {
      columns: ["id", "org_id", "first_name", "last_name", "city"],
      rows: [
        { id: OTHER_PATIENT, org_id: OTHER_ORG, first_name: "Other", last_name: "Tenant", city: "Elsewhere" },
        { id: PATIENT, org_id: ORG, first_name: "Test", last_name: "Patient", city: "Tampa" },
      ],
    },
    app_user: {
      columns: ["id", "full_name"],
      rows: [
        { id: ME, full_name: "Priya Raman" },
        { id: COLLEAGUE, full_name: "Marcus Delgado" },
        { id: STRANGER, full_name: "Someone Else" },
      ],
    },
    org_member: {
      columns: ["org_id", "user_id", "status"],
      rows: [
        { org_id: OTHER_ORG, user_id: ME, status: "active" },
        { org_id: OTHER_ORG, user_id: STRANGER, status: "active" },
        { org_id: ORG, user_id: ME, status: "active" },
        { org_id: ORG, user_id: COLLEAGUE, status: "active" },
      ],
    },
    org: {
      columns: ["id", "daily_visit_capacity", "timezone"],
      rows: [
        { id: OTHER_ORG, daily_visit_capacity: 3, timezone: "America/Chicago" },
        { id: ORG, daily_visit_capacity: 8, timezone: "America/New_York" },
      ],
    },
    visit_service: {
      columns: Object.keys(service(S_SYMPTOM, ORG, "x", 0)),
      rows: [
        service(S_OTHER_ONLY, OTHER_ORG, "chaplaincy", 500),
        service(S_OTHER_SHARED, OTHER_ORG, "symptom management", 510),
        service(S_SYMPTOM, ORG, "symptom management", 10),
        service(S_WOUND, ORG, "wound care", 20),
      ],
    },
    visit_service_provided: {
      columns: Object.keys(provided(MINE, S_WOUND, ORG)),
      rows: [
        provided(FOREIGN, S_OTHER_ONLY, OTHER_ORG),
        // Both of these are what setVisitServices wrote on a bypassing
        // connection before its catalog check named the org: the other org's
        // row on this org's service, and this org's row on the other org's.
        provided(FOREIGN, S_SYMPTOM, OTHER_ORG),
        provided(MINE_VIDEO, S_OTHER_SHARED, ORG),
        provided(MINE, S_WOUND, ORG),
        provided(MINE_VIDEO, S_SYMPTOM, ORG),
      ],
    },
    audit_log: {
      columns: ["org_id", "user_id", "action", "target_type", "target_id", "payload", "ip_address", "user_agent"],
      rows: [],
    },
  };
}

let db: FakeDb;
let log: string[];
let nextId: number;

/**
 * sql-fake's transaction with the rewrites listed at the top. Every statement,
 * rewritten or not, is run by sql-fake against the tables with the binds the
 * service sent; the original statement is what `log` records.
 */
function tx() {
  const exec = (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[] | number> => {
    const original = prepare(strings);
    log.push(original);
    try {
      let sql = original;
      if (/^SELECT v\.status, v\.document_text,/.test(sql)) {
        sql = `SELECT v.status, v.clinician_user_id, NULL AS coding_basis${sql.slice(sql.lastIndexOf(" FROM visit v WHERE "))}`;
      }
      sql = sql
        .replace(/\blower\(([^()]+)\)/g, "$1")
        .replace(/\b(\w+) NOT IN \('([^']*)', '([^']*)'\)/g, "$1 <> '$2' AND $1 <> '$3'")
        .replace(
          /\(COALESCE\(scheduled_start, start_time\) AT TIME ZONE \$\d+\) = \(\$\d+ AT TIME ZONE \$\d+\)/g,
          "true",
        )
        .replace(
          /COALESCE\(\(SELECT MAX\((\w+)\) \+ 10 FROM (\w+)((?: WHERE [^()]*)?)\), 100\)/g,
          (_m, col: string, table: string, where: string) => {
            const found = run(db, [`SELECT ${col} FROM ${table}${where}`], values) as SqlRow[];
            const orders = found.map((r) => Number(r[col]));
            return String(orders.length > 0 ? Math.max(...orders) + 10 : 100);
          },
        )
        .replace(/ ON CONFLICT \([^()]*\) DO UPDATE SET .*$/, "");
      let id: string | null = null;
      const returning = /^INSERT INTO (\w+) \(([^()]*)\) VALUES \((.*)\) RETURNING id$/.exec(sql);
      if (returning) {
        id = `90000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
        sql = `INSERT INTO ${returning[1]} (id, ${returning[2]}) VALUES ('${id}', ${returning[3]})`;
      }
      const out = run(db, [sql], values);
      return Promise.resolve(id === null ? out : [{ id }]);
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

beforeEach(() => {
  db = load();
  log = [];
  nextId = 0;
  vi.mocked(withOrgContext).mockReset();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (t: unknown) => Promise<unknown>)(tx()),
  );
  vi.mocked(requireAuth).mockReset();
});

const rowOf = (table: string, id: string) => db[table]!.rows.find((r) => r.id === id)!;
const visitCount = () => db.visit!.rows.length;
const audits = () => db.audit_log!.rows;
const ran = (re: RegExp) => log.filter((s) => re.test(s));

const CLINICIAN = ROLE_DEFAULT_PERMISSIONS.clinician;
const BILLING_AGENT = ROLE_DEFAULT_PERMISSIONS.billing_agent;

function session(permissions: string[]) {
  return { userId: ME, orgId: ORG, permissions, role: "clinician", email: "me@example.test" };
}

describe("getVisit", () => {
  it("does not read another org's visit by its id", async () => {
    expect(await getVisit({ orgId: ORG, id: FOREIGN })).toBeNull();
  });

  it("CONTROL: reads this org's visit, with this org's band for its type", async () => {
    const v = await getVisit({ orgId: ORG, id: MINE_VIDEO });
    expect(v).toMatchObject({ id: MINE_VIDEO, visitTypeLabel: "Video visit", visitTypeIsTelehealth: true });
  });
});

describe("listVisits", () => {
  it("lists this org's visits only", async () => {
    const rows = await listVisits({ orgId: ORG, limit: 200 });
    expect(rows.map((r) => r.id).sort()).toEqual([...ORG_VISITS].sort());
  });

  it("does not show another org's patient on a visit booked against them", async () => {
    const rows = await listVisits({ orgId: ORG, limit: 200 });
    expect(rows.find((r) => r.id === CROSS_PATIENT)).toMatchObject({ patientName: null, patientCity: null });
    // CONTROL: the join still names this org's own patient.
    expect(rows.find((r) => r.id === MINE)).toMatchObject({ patientName: "Test Patient", patientCity: "Tampa" });
  });
});

describe("GET /api/visits", () => {
  const list = async (qs: string) => {
    const res = await visitsGet(new Request(`http://localhost/api/visits${qs}`) as unknown as NextRequest);
    return ((await res.json()) as { data: { rows: { id: string }[]; total: number } }).data;
  };

  it("lists and counts this org's visits for visits.view.all", async () => {
    vi.mocked(requireAuth).mockResolvedValue(session(BILLING_AGENT) as never);
    const d = await list("?limit=200");
    expect(d.rows.map((r) => r.id).sort()).toEqual([...ORG_VISITS].sort());
    expect(d.total).toBe(ORG_VISITS.length);
  });

  it("lists and counts a .own caller's visits in this org only, though they work in both", async () => {
    vi.mocked(requireAuth).mockResolvedValue(session(CLINICIAN) as never);
    const d = await list("?limit=200");
    expect(d.rows.map((r) => r.id).sort()).toEqual([MINE, MINE_VIDEO, MINE_CANCELLED].sort());
    expect(d.total).toBe(3);
  });
});

describe("requireVisitAccess", () => {
  it("answers 404 'Visit not found.' for another org's visit, even to visits.view.all", async () => {
    const res = await requireVisitAccess({ session: session(BILLING_AGENT), visitId: FOREIGN });
    expect(res?.status).toBe(404);
    expect((await res!.json()).error).toBe("Visit not found.");
  });

  it("answers 404 for another org's visit whose clinician is the caller", async () => {
    // ME is FOREIGN's clinician in the other org. Ownership must not open it here.
    const res = await requireVisitAccess({ session: session(CLINICIAN), visitId: FOREIGN });
    expect(res?.status).toBe(404);
  });

  it("CONTROL: lets the clinician at their own visit in this org", async () => {
    expect(await requireVisitAccess({ session: session(CLINICIAN), visitId: MINE })).toBeNull();
  });

  it("still refuses a .own caller a colleague's visit in this org (403)", async () => {
    const res = await requireVisitAccess({ session: session(CLINICIAN), visitId: COLLEAGUES });
    expect(res?.status).toBe(403);
  });
});

describe("scheduleVisit", () => {
  const booking = (over: Partial<ScheduleVisit> = {}): ScheduleVisit => ({
    patientId: PATIENT,
    clinicianUserId: ME,
    visitType: "established_patient_home",
    scheduledStart: "2026-09-26T14:00:00.000Z",
    isTelehealth: false,
    ...over,
  });

  it("refuses a slug only the other org has, and books nothing", async () => {
    const before = visitCount();
    const err = await scheduleVisit({ orgId: ORG, payload: booking({ visitType: "other_org_only" }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe('"other_org_only" is not one of your visit types.');
    expect(visitCount()).toBe(before);
  });

  it("takes this org's telehealth flag for a slug both orgs have", async () => {
    const r = await scheduleVisit({ orgId: ORG, payload: booking({ visitType: "video_visit" }) });
    expect(rowOf("visit", r.id)).toMatchObject({ is_telehealth: true, telehealth_modality: "audio_video" });
  });

  it("refuses another org's patient with a 422, and books nothing", async () => {
    const before = visitCount();
    const err = await scheduleVisit({ orgId: ORG, payload: booking({ patientId: OTHER_PATIENT }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(`Patient ${OTHER_PATIENT} is not one of this organization's patients.`);
    expect(visitCount()).toBe(before);
  });

  it("CONTROL: books this org's patient on this org's type, into this org", async () => {
    const before = visitCount();
    const r = await scheduleVisit({ orgId: ORG, payload: booking() });
    expect(visitCount()).toBe(before + 1);
    expect(rowOf("visit", r.id)).toMatchObject({
      org_id: ORG, patient_id: PATIENT, clinician_user_id: ME, visit_type: "established_patient_home",
      is_telehealth: false, telehealth_modality: null, status: "scheduled",
    });
  });
});

describe("resolveCodingBasis", () => {
  it("is gone: the unscoped slug lookup nothing called", async () => {
    // It read the band by slug alone, so on a connection that bypasses RLS a
    // slug both orgs have came back with the other org's band. No caller, so
    // it is deleted rather than scoped.
    expect(Object.keys(await import("../visit-types.service"))).not.toContain("resolveCodingBasis");
  });
});

describe("listVisitTypes", () => {
  it("lists this org's types, counting this org's visits only", async () => {
    const types = await listVisitTypes({ orgId: ORG });
    expect(types.map((t) => [t.slug, t.codingBasis, t.isTelehealth, t.usageCount])).toEqual([
      ["established_patient_home", "established_patient_home", false, 4],
      ["video_visit", "established_patient_home", true, 1],
      ["bereavement_follow_up", "non_billable", false, 0],
    ]);
  });

  it("CONTROL: includeInactive adds this org's switched-off type, still nobody else's", async () => {
    const types = await listVisitTypes({ orgId: ORG, includeInactive: true });
    expect(types.map((t) => t.id)).toEqual([T_EST, T_VIDEO, T_BEREAVEMENT, T_RETIRED]);
  });
});

describe("createVisitType", () => {
  it("creates a slug only the other org has, at the end of this org's list", async () => {
    const r = await createVisitType({
      orgId: ORG,
      payload: { label: "Other org only", codingBasis: "new_patient_home" },
      actorUserId: ME,
    });
    expect(r.slug).toBe("other_org_only");
    expect(rowOf("org_visit_type", r.id)).toMatchObject({ org_id: ORG, slug: "other_org_only", sort_order: 50 });
  });

  it("CONTROL: still refuses a slug this org already has", async () => {
    await expect(
      createVisitType({ orgId: ORG, payload: { label: "Video visit", codingBasis: "new_patient_home" }, actorUserId: ME }),
    ).rejects.toThrow('"Video visit" already exists.');
  });
});

describe("updateVisitType", () => {
  it("does not edit another org's type: NotFound, unchanged, no audit row", async () => {
    const err = await updateVisitType({ orgId: ORG, id: T_OTHER_VIDEO, payload: { label: "Renamed" }, actorUserId: ME })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toBe("Visit type not found.");
    expect(rowOf("org_visit_type", T_OTHER_VIDEO).label).toBe("Video (other org)");
    expect(audits()).toHaveLength(0);
  });

  it("counts this org's active types only when refusing to switch off the last one", async () => {
    for (const r of db.org_visit_type!.rows) if (r.org_id === ORG && r.id !== T_EST) r.active = false;
    await expect(
      updateVisitType({ orgId: ORG, id: T_EST, payload: { active: false }, actorUserId: ME }),
    ).rejects.toThrow("Keep at least one active visit type.");
    expect(rowOf("org_visit_type", T_EST).active).toBe(true);
    expect(audits()).toHaveLength(0);
  });

  it("CONTROL: switches off this org's type, with one audit row of closed-set fields", async () => {
    expect(await updateVisitType({ orgId: ORG, id: T_VIDEO, payload: { active: false }, actorUserId: ME })).toEqual({
      updated: true,
    });
    expect(rowOf("org_visit_type", T_VIDEO).active).toBe(false);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ org_id: ORG, action: "settings_update", target_id: T_VIDEO });
    expect(JSON.parse(String(audits()[0]!.payload))).toEqual({ change: "deactivate", fields: ["active"] });
  });
});

describe("documentVisit", () => {
  it("does not write to another org's visit: NotFound, nothing written", async () => {
    await expect(
      documentVisit({ orgId: ORG, id: FOREIGN_IN_PROGRESS, payload: { acpMinutes: 30 } }),
    ).rejects.toThrow(NotFoundError);
    expect(rowOf("visit", FOREIGN_IN_PROGRESS).acp_minutes).toBe(0);
    expect(ran(/^UPDATE visit /)).toHaveLength(0);
  });

  it("CONTROL: writes this org's visit", async () => {
    expect(await documentVisit({ orgId: ORG, id: MINE_VIDEO, payload: { acpMinutes: 30 } })).toEqual({ updated: true });
    expect(rowOf("visit", MINE_VIDEO).acp_minutes).toBe(30);
  });
});

describe("transitionVisit", () => {
  it("does not move another org's visit: NotFound, no UPDATE, no audit row", async () => {
    await expect(
      transitionVisit({ orgId: ORG, id: FOREIGN, to: "cancelled", signedByUserId: ME }),
    ).rejects.toThrow("Visit not found.");
    expect(rowOf("visit", FOREIGN).status).toBe("scheduled");
    expect(ran(/^UPDATE visit /)).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("CONTROL: cancels this org's visit, with one audit row", async () => {
    expect(await transitionVisit({ orgId: ORG, id: MINE, to: "cancelled", signedByUserId: ME })).toEqual({
      from: "scheduled",
      to: "cancelled",
    });
    expect(rowOf("visit", MINE).status).toBe("cancelled");
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ org_id: ORG, action: "visit_document", target_id: MINE });
    expect(JSON.parse(String(audits()[0]!.payload))).toEqual({ from: "scheduled", to: "cancelled" });
  });
});

describe("getDailyCapacityStatus", () => {
  it("counts the clinician's visits in this org only, though they work in both", async () => {
    // ME that day: MINE and MINE_VIDEO here (MINE_CANCELLED does not count),
    // FOREIGN and FOREIGN_IN_PROGRESS in the other org.
    expect(
      await getDailyCapacityStatus({ orgId: ORG, clinicianUserId: ME, at: "2026-09-25T09:00:00.000Z" }),
    ).toEqual({ count: 2, capacity: 8, over: false });
  });
});

describe("visit services", () => {
  it("lists this org's catalog, counting this org's provided rows only", async () => {
    const catalog = await listServiceCatalog({ orgId: ORG });
    expect(catalog.map((s) => [s.id, s.usageCount])).toEqual([
      [S_SYMPTOM, 1],
      [S_WOUND, 1],
    ]);
  });

  it("refuses another org's service on this org's visit, and deletes nothing", async () => {
    const before = db.visit_service_provided!.rows.map((r) => ({ ...r }));
    await expect(
      setVisitServices({ orgId: ORG, visitId: MINE, payload: { services: [{ serviceId: S_OTHER_ONLY }] } }),
    ).rejects.toThrow("One or more services are not in your catalog.");
    expect(db.visit_service_provided!.rows).toEqual(before);
  });

  it("does not replace the services on another org's visit", async () => {
    const before = db.visit_service_provided!.rows.map((r) => ({ ...r }));
    await expect(
      setVisitServices({ orgId: ORG, visitId: FOREIGN, payload: { services: [] } }),
    ).rejects.toThrow("Visit not found.");
    expect(db.visit_service_provided!.rows).toEqual(before);
  });

  it("CONTROL: replaces this org's visit's services from this org's catalog", async () => {
    expect(
      await setVisitServices({ orgId: ORG, visitId: MINE, payload: { services: [{ serviceId: S_SYMPTOM }] } }),
    ).toEqual({ count: 1 });
    expect(db.visit_service_provided!.rows.filter((r) => r.visit_id === MINE).map((r) => r.service_id)).toEqual([
      S_SYMPTOM,
    ]);
  });

  it("creates a service named like one only the other org has, at the end of this org's catalog", async () => {
    const r = await createService({ orgId: ORG, payload: { name: "chaplaincy" }, actorUserId: ME });
    expect(rowOf("visit_service", r.id)).toMatchObject({ org_id: ORG, name: "chaplaincy", sort_order: 30 });
  });

  it("CONTROL: still refuses a name this org already has", async () => {
    await expect(createService({ orgId: ORG, payload: { name: "wound care" }, actorUserId: ME })).rejects.toThrow(
      '"wound care" is already in the catalog.',
    );
  });

  it("renames onto a name only the other org has", async () => {
    expect(await updateService({ orgId: ORG, id: S_WOUND, payload: { name: "chaplaincy" }, actorUserId: ME })).toEqual({
      updated: true,
    });
    expect(rowOf("visit_service", S_WOUND).name).toBe("chaplaincy");
  });

  it("CONTROL: still refuses a rename onto another of this org's names", async () => {
    await expect(
      updateService({ orgId: ORG, id: S_WOUND, payload: { name: "symptom management" }, actorUserId: ME }),
    ).rejects.toThrow('"symptom management" is already in the catalog.');
  });

  it("does not edit another org's service: NotFound, unchanged, no audit row", async () => {
    await expect(
      updateService({ orgId: ORG, id: S_OTHER_ONLY, payload: { active: false }, actorUserId: ME }),
    ).rejects.toThrow("Service not found.");
    expect(rowOf("visit_service", S_OTHER_ONLY).active).toBe(true);
    expect(audits()).toHaveLength(0);
  });

  it("lists nothing provided on another org's visit", async () => {
    expect(await listVisitServices({ orgId: ORG, visitId: FOREIGN })).toEqual([]);
  });

  it("lists this org's visit's services from this org's catalog only", async () => {
    // MINE_VIDEO also carries a row on the other org's "symptom management".
    const rows = await listVisitServices({ orgId: ORG, visitId: MINE_VIDEO });
    expect(rows.map((r) => r.serviceId)).toEqual([S_SYMPTOM]);
  });
});
