/**
 * GET /api/visits — whose visits a caller is shown (Level-1 audit, 27 Oct).
 *
 *   - visits.view.own: their own, as always;
 *   - the patient's clinical care team: all of that patient's visits (doc:49);
 *   - the practice's scheduler (schedule.manage.all): every clinician's
 *     BOOKED visits, the schedule board, without any note text.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/visits/visit.service", () => ({
  listVisits: vi.fn(),
  getDailyCapacityStatus: vi.fn(),
  scheduleVisit: vi.fn(),
}));
vi.mock("@/lib/features/visits/visit-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/visits/visit-access")>()),
  isOnClinicalCareTeam: vi.fn(),
}));

import { GET } from "@/app/api/visits/route";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import { isOnClinicalCareTeam } from "@/lib/features/visits/visit-access";
import { listVisits } from "@/lib/features/visits/visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "c0000000-0000-4000-8000-00000000000c";

const as = (permissions: string[]) =>
  vi.mocked(requireAuth).mockResolvedValue({ userId: ME, orgId: ORG, permissions, role: "clinician", email: "x" } as never);
const get = (qs: string) => GET(new Request(`http://localhost/api/visits${qs}`) as unknown as NextRequest);
/** The clinician filter the list was asked for. */
const filtered = () => vi.mocked(listVisits).mock.calls.at(-1)![0].clinicianUserId;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({ $queryRaw: () => Promise.resolve([{ n: BigInt(1) }]) }),
  );
  vi.mocked(listVisits).mockResolvedValue([
    { id: "v1", clinicianUserId: OTHER, documentText: "a colleague's words" },
    { id: "v2", clinicianUserId: ME, documentText: "my words" },
  ] as never);
  vi.mocked(isOnClinicalCareTeam).mockResolvedValue(false);
});

describe("GET /api/visits", () => {
  it("CONTROL: a clinician is shown their own visits only", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.clinician);
    expect((await get(`?patientId=${PATIENT}`)).status).toBe(200);
    expect(filtered()).toBe(ME);
  });

  it("shows a care-team member all of their patient's visits", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.clinician);
    vi.mocked(isOnClinicalCareTeam).mockResolvedValue(true);
    await get(`?patientId=${PATIENT}`);
    expect(filtered()).toBeUndefined();
    expect(vi.mocked(isOnClinicalCareTeam).mock.calls[0]![0]).toEqual({ orgId: ORG, patientId: PATIENT, userId: ME });
  });

  it("shows the scheduler every clinician's booked visits, with no note text but their own", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.intake_coordinator);
    const body = await (await get("?status=scheduled&limit=200")).json();
    expect(filtered()).toBeUndefined();
    expect(body.data.rows).toEqual([
      { id: "v1", clinicianUserId: OTHER, documentText: null },
      { id: "v2", clinicianUserId: ME, documentText: "my words" },
    ]);
  });

  it("CONTROL: the scheduler's grant opens no other list", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.intake_coordinator);
    await get(`?patientId=${PATIENT}`);
    expect(filtered()).toBe(ME);
    await get("?status=documented");
    expect(filtered()).toBe(ME);
  });

  it("CONTROL: a caller with none of the three is refused", async () => {
    as(["patients.view"]);
    expect((await get("")).status).toBe(403);
  });
});

describe("GET /api/visits: the rest of a chart its reader cannot list", () => {
  /** The values each count bound, and the answers it gets, in order. */
  let counted: unknown[][];
  const countsAnswer = (...ns: number[]) => {
    counted = [];
    vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        $queryRaw: (_s: TemplateStringsArray, ...values: unknown[]) => {
          counted.push(values);
          return Promise.resolve([{ n: BigInt(ns.shift() ?? 0) }]);
        },
      }),
    );
  };
  const body = async (qs: string) => (await (await get(qs)).json()).data;

  it("tells a clinician outside the care team how many more the chart holds, never which", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.clinician);
    countsAnswer(1, 5);
    const d = await body(`?patientId=${PATIENT}`);
    expect(d.total).toBe(1);
    expect(d.withheld).toBe(4);
    expect(filtered()).toBe(ME);
    // The second count is the whole chart's: this patient, this org, nobody's.
    expect(counted[1]).toContain(PATIENT);
    expect(counted[1]).toContain(ORG);
    expect(counted[1]).not.toContain(ME);
  });

  it("tells the intake coordinator the same: booking opens no notes, and the chart still may not say none exist", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.intake_coordinator);
    countsAnswer(0, 5);
    const d = await body(`?patientId=${PATIENT}`);
    expect(d.withheld).toBe(5);
  });

  it("counts under the list's own status filter", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.clinician);
    countsAnswer(0, 2);
    await body(`?patientId=${PATIENT}&status=documented`);
    expect(counted[1]).toContain("documented");
  });

  it("CONTROL: nothing is withheld from the care team, who are shown it all", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.clinician);
    vi.mocked(isOnClinicalCareTeam).mockResolvedValue(true);
    countsAnswer(5);
    expect((await body(`?patientId=${PATIENT}`)).withheld).toBe(0);
    expect(counted).toHaveLength(1);
  });

  it("CONTROL: nothing is withheld from a visits.view.all holder", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.org_admin);
    countsAnswer(5);
    expect((await body(`?patientId=${PATIENT}`)).withheld).toBe(0);
    expect(counted).toHaveLength(1);
  });

  it("CONTROL: a list that is not one chart says nothing about the practice's other visits", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.clinician);
    countsAnswer(3, 200);
    expect((await body("?limit=100")).withheld).toBe(0);
    expect(counted).toHaveLength(1);
  });

  it("CONTROL: the schedule board is not a chart", async () => {
    as(ROLE_DEFAULT_PERMISSIONS.intake_coordinator);
    countsAnswer(5);
    expect((await body(`?patientId=${PATIENT}&status=scheduled`)).withheld).toBe(0);
    expect(counted).toHaveLength(1);
  });

  it("CONTROL: a caller who cannot open the chart is told nothing about it", async () => {
    as(["visits.view.own"]);
    countsAnswer(1, 5);
    expect((await body(`?patientId=${PATIENT}`)).withheld).toBe(0);
    expect(counted).toHaveLength(1);
  });
});
