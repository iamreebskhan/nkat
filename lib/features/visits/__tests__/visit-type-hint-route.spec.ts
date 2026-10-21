/**
 * GET /api/patients/[id]/visit-type-hint — Pallio's own history for one
 * patient, as the scheduler and the document screen's Visit type card read it.
 *
 * Its own route, not GET /api/visits: that list narrows a visits.view.own
 * caller to their own visits (app/api/visits/route.ts), so a clinician would
 * miss a colleague's visit — and under the CMS same-group rule that visit is
 * exactly what makes the patient established. It returns a patient's visit
 * history, so every read is logged as PHI access.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/visits/visit.service", () => ({ findPriorVisit: vi.fn() }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({ logPhiAccess: vi.fn() }));

import { GET } from "@/app/api/patients/[id]/visit-type-hint/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { findPriorVisit } from "@/lib/features/visits/visit.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

import { VIEW_ANY_VISIT } from "../visit-access";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const VISIT = "e0000000-0000-4000-8000-00000000000a";

const HINT = {
  lastVisitAt: "2025-09-25T14:00:00.000Z",
  lastVisitStatus: "documented",
  windowStart: "2023-09-26T14:00:00.000Z",
  suggestedBasis: "established_patient_home",
} as const;

const session = (permissions: string[]): Session => ({
  userId: USER,
  orgId: ORG,
  role: "clinician",
  permissions,
  email: "nurse@design-partner.test",
});

function get(query = "", id = PATIENT): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new Request(
    `http://localhost/api/patients/${id}/visit-type-hint${query}`,
  ) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ id }) }];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(session(["patients.view"]));
  vi.mocked(findPriorVisit).mockResolvedValue(HINT);
});

describe("GET /api/patients/[id]/visit-type-hint", () => {
  it("answers the hint for the date asked about, leaving out the visit being documented", async () => {
    const at = "2026-09-26T15:00:00.000Z";
    const res = await GET(...get(`?at=${encodeURIComponent(at)}&excludeVisitId=${VISIT}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: HINT, error: null });
    expect(findPriorVisit).toHaveBeenCalledWith({
      orgId: ORG,
      patientId: PATIENT,
      before: new Date(at),
      excludeVisitId: VISIT,
    });
  });

  it("takes an offset timestamp, and now when no date is given", async () => {
    await GET(...get(`?at=${encodeURIComponent("2026-09-26T10:00:00-05:00")}`));
    expect(vi.mocked(findPriorVisit).mock.calls[0]![0].before.toISOString()).toBe("2026-09-26T15:00:00.000Z");
    const t0 = Date.now();
    await GET(...get());
    const before = vi.mocked(findPriorVisit).mock.calls[1]![0].before.getTime();
    expect(before).toBeGreaterThanOrEqual(t0);
    expect(before).toBeLessThanOrEqual(Date.now());
  });

  it("serves visits.view.all without patients.view", async () => {
    vi.mocked(requireAuth).mockResolvedValue(session([VIEW_ANY_VISIT]));
    expect((await GET(...get())).status).toBe(200);
  });

  it("logs the read as PHI access: it is a patient's visit history", async () => {
    await GET(...get());
    expect(logPhiAccess).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logPhiAccess).mock.calls[0]![0]).toMatchObject({
      orgId: ORG,
      userId: USER,
      patientId: PATIENT,
      accessType: "view",
      context: "visit_type_hint",
    });
  });

  it("refuses visits.view.own alone, without reading or logging anything", async () => {
    vi.mocked(requireAuth).mockResolvedValue(session(["visits.view.own"]));
    const res = await GET(...get());
    expect(res.status).toBe(403);
    expect(findPriorVisit).not.toHaveBeenCalled();
    expect(logPhiAccess).not.toHaveBeenCalled();
  });

  it("answers 422 for a date it cannot read, and 404 for an id that is not a uuid", async () => {
    expect((await GET(...get("?at=yesterday"))).status).toBe(422);
    expect((await GET(...get("?excludeVisitId=not-a-uuid"))).status).toBe(422);
    expect((await GET(...get("", "not-a-uuid"))).status).toBe(404);
    expect(findPriorVisit).not.toHaveBeenCalled();
    expect(logPhiAccess).not.toHaveBeenCalled();
  });
});
