/**
 * findPriorVisit — what Pallio's own history says about new vs established.
 *
 * CMS 100-04 ch.12 §30.6.7(A) and the CPT E/M guidelines: a patient is new if
 * they have not received a professional service from this physician or NPP, or
 * another of the same specialty in the same group, within the past three
 * years. Pallio sees only its own visits, so this is a HINT for the scheduler
 * and the document screen, never a decision (the visit-type fix leaves the
 * choice with the clinician).
 *
 * The statement the service wrote is RUN by sql-fake against two orgs' rows,
 * with no RLS, so a predicate that is dropped changes what comes back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { fakeTx, type FakeDb, type SqlRow } from "@/lib/features/team/__tests__/sql-fake";

import { findPriorVisit } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "f0000000-0000-4000-8000-000000000002";
const CLINICIAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** The visit being scheduled or documented: 25 Sep 2026, 15:00 UTC. */
const BEFORE = new Date("2026-09-25T15:00:00.000Z");
/** Three years before it, to the millisecond. */
const WINDOW_START = new Date("2023-09-25T15:00:00.000Z");

let seq = 0;
function visit(over: Partial<SqlRow> & { at?: Date; scheduled?: Date }): SqlRow {
  const { at, scheduled, ...rest } = over;
  seq++;
  return {
    id: `e0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    org_id: ORG,
    patient_id: PATIENT,
    clinician_user_id: CLINICIAN,
    visit_type: "established_patient_home",
    status: "documented",
    start_time: at ?? null,
    scheduled_start: scheduled ?? at ?? null,
    ...rest,
  };
}

/** The org's types. bereavement_follow_up bills differently in each org, as it does in the real data. */
const TYPES: SqlRow[] = [
  { org_id: OTHER_ORG, slug: "bereavement_follow_up", coding_basis: "established_patient_home" },
  { org_id: ORG, slug: "new_patient_home", coding_basis: "new_patient_home" },
  { org_id: ORG, slug: "established_patient_home", coding_basis: "established_patient_home" },
  { org_id: ORG, slug: "bereavement_follow_up", coding_basis: "non_billable" },
  { org_id: OTHER_ORG, slug: "established_patient_home", coding_basis: "established_patient_home" },
];

let db: FakeDb;

function withVisits(rows: SqlRow[]): void {
  db = {
    visit: {
      columns: [
        "id", "org_id", "patient_id", "clinician_user_id", "visit_type", "status",
        "start_time", "scheduled_start",
      ],
      rows,
    },
    org_visit_type: { columns: ["org_id", "slug", "coding_basis"], rows: TYPES },
  };
}

beforeEach(() => {
  seq = 0;
  withVisits([]);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx(db)),
  );
});

const hint = (excludeVisitId?: string) =>
  findPriorVisit({ orgId: ORG, patientId: PATIENT, before: BEFORE, excludeVisitId });

const yearsBefore = (n: number, extraMs = 0) => {
  const d = new Date(BEFORE);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return new Date(d.getTime() + extraMs);
};

describe("findPriorVisit", () => {
  it("a documented visit a year earlier makes the patient established", async () => {
    const at = yearsBefore(1);
    withVisits([visit({ at })]);
    expect(await hint()).toEqual({
      lastVisitAt: at.toISOString(),
      lastVisitStatus: "documented",
      windowStart: WINDOW_START.toISOString(),
      suggestedBasis: "established_patient_home",
    });
  });

  it("CONTROL — a visit four years earlier is outside the window: new", async () => {
    withVisits([visit({ at: yearsBefore(4) })]);
    expect(await hint()).toEqual({
      lastVisitAt: null,
      lastVisitStatus: null,
      windowStart: WINDOW_START.toISOString(),
      suggestedBasis: "new_patient_home",
    });
  });

  it("counts a visit exactly at the start of the window", async () => {
    withVisits([visit({ at: WINDOW_START })]);
    expect((await hint()).lastVisitAt).toBe(WINDOW_START.toISOString());
    // …and not one a millisecond earlier.
    withVisits([visit({ at: new Date(WINDOW_START.getTime() - 1) })]);
    expect((await hint()).lastVisitAt).toBeNull();
  });

  it("does not count a visit exactly at `before`, or after it", async () => {
    withVisits([visit({ at: BEFORE })]);
    expect((await hint()).suggestedBasis).toBe("new_patient_home");
    withVisits([visit({ at: new Date(BEFORE.getTime() + 60_000) })]);
    expect((await hint()).suggestedBasis).toBe("new_patient_home");
    // CONTROL: a minute before it does count.
    withVisits([visit({ at: new Date(BEFORE.getTime() - 60_000) })]);
    expect((await hint()).suggestedBasis).toBe("established_patient_home");
  });

  it("ignores cancelled and no-show visits", async () => {
    withVisits([
      visit({ at: yearsBefore(1), status: "cancelled" }),
      visit({ at: yearsBefore(2), status: "no_show" }),
    ]);
    expect((await hint()).lastVisitAt).toBeNull();
  });

  it("ignores a visit whose type does not bill (bereavement, caregiver-only)", async () => {
    // In ORG bereavement_follow_up is non_billable; in OTHER_ORG the same slug
    // bills as established. Only the visit's own org's row may decide.
    withVisits([visit({ at: yearsBefore(1), visit_type: "bereavement_follow_up" })]);
    expect((await hint()).lastVisitAt).toBeNull();
  });

  it("counts a visit whose slug has no type row, so an unknown case leans established", async () => {
    const at = yearsBefore(1);
    withVisits([visit({ at, visit_type: "retired_custom_type" })]);
    expect((await hint()).lastVisitAt).toBe(at.toISOString());
  });

  it("ignores another patient, and the same patient id in another org", async () => {
    withVisits([
      visit({ at: yearsBefore(1), patient_id: OTHER_PATIENT }),
      visit({ at: yearsBefore(1), org_id: OTHER_ORG }),
    ]);
    expect((await hint()).lastVisitAt).toBeNull();
  });

  it("leaves out the visit being documented when asked to", async () => {
    const self = visit({ at: yearsBefore(0, -3_600_000), status: "in_progress" });
    withVisits([self]);
    expect((await hint(self.id as string)).lastVisitAt).toBeNull();
    // CONTROL: without the exclusion it is its own prior visit.
    expect((await hint()).lastVisitAt).not.toBeNull();
  });

  it("reports an earlier visit that is only booked, with its status", async () => {
    const booked = new Date(BEFORE.getTime() - 86_400_000);
    withVisits([visit({ scheduled: booked, status: "scheduled" })]);
    expect(await hint()).toMatchObject({
      lastVisitAt: booked.toISOString(),
      lastVisitStatus: "scheduled",
      suggestedBasis: "established_patient_home",
    });
  });

  it("names the most recent prior visit, dated by when it started", async () => {
    // start_time wins over scheduled_start: a visit booked for one day and held
    // on another is dated by when it was held.
    const held = yearsBefore(0, -7 * 86_400_000);
    withVisits([
      visit({ at: yearsBefore(2) }),
      visit({ at: held, scheduled: yearsBefore(0, -30 * 86_400_000) }),
      visit({ at: yearsBefore(1) }),
    ]);
    expect((await hint()).lastVisitAt).toBe(held.toISOString());
  });
});
