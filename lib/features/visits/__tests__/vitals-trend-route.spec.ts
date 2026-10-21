/**
 * GET /api/patients/[id]/vitals — the page size, and what comes back.
 *
 * Both halves were untested. The route asked getVitalsTrend for nothing and
 * took its 50-row default, so a patient seen weekly for 14 months (~60 visits
 * with vitals) lost the OLDEST ten off a newest-first LIMIT — and those carry
 * the baseline the screen exists to show, the "160 pounds" in "weight loss
 * from 160 pounds to a current 128 pounds". And the response body is
 * destructured from the service's { rows, total }, which nothing asserted:
 * the one other spec that drives this route stubbed the service with a bare
 * array, so the route answered 200 with both fields undefined and that spec
 * stayed green. That stub now returns { rows, total } and asserts the body,
 * so both specs would notice the route dropping the trend.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/visits/note.service", () => ({ getVitalsTrend: vi.fn() }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({ logPhiAccess: vi.fn() }));

import { GET } from "@/app/api/patients/[id]/vitals/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { getVitalsTrend } from "@/lib/features/visits/note.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "f0000000-0000-4000-8000-000000000001";

const session = (permissions: string[]): Session => ({
  userId: USER,
  orgId: ORG,
  role: "clinician",
  permissions,
  email: "nurse@design-partner.test",
});

function get(): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new Request(
    `http://localhost/api/patients/${PATIENT}/vitals`,
  ) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ id: PATIENT }) }];
}

const row = (weightKg: number) => ({
  visitId: "e0000000-0000-4000-8000-00000000000a",
  dateOfService: "2026-09-09T10:00:00.000Z",
  recordedAt: "2026-09-09T10:00:00.000Z",
  heightCm: null,
  weightKg,
  bpSystolic: null,
  bpDiastolic: null,
  heartRate: null,
  respRate: null,
  temperatureC: null,
  spo2Percent: null,
  ppsPercent: null,
  painScore: null,
  notes: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(session(["patients.view"]));
  vi.mocked(getVitalsTrend).mockResolvedValue({ rows: [row(58.06)], total: 61 });
});

describe("GET /api/patients/[id]/vitals", () => {
  it("asks for the whole history the service will give, not its 50-row default", async () => {
    // The clinical failure this route exists to avoid. getVitalsTrend clamps
    // to 200 itself (note.service.ts) and its own spec pins that clamp, so
    // asking for 200 widens nothing — it just stops the route settling for a
    // page that drops the baseline weight.
    await GET(...get());
    expect(vi.mocked(getVitalsTrend).mock.calls[0]![0].limit).toBe(200);
  });

  it("returns the page and the true total, not one dressed as the other", async () => {
    // The screen reads both: `trend` is what it draws, `total` is what lets it
    // say "Latest 200 of 206" instead of calling a page the whole record.
    const res = await GET(...get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(61);
    expect(body.data.trend).toHaveLength(1);
    expect(body.data.trend[0].weightKg).toBe(58.06);
  });

  it("scopes the read to the caller's own org", async () => {
    await GET(...get());
    expect(vi.mocked(getVitalsTrend).mock.calls[0]![0]).toMatchObject({
      orgId: ORG,
      patientId: PATIENT,
    });
  });

  it("refuses a caller who cannot open the patient record, without reading it", async () => {
    // CONTROL: these are a named patient's clinical readings. A caller holding
    // neither patients.view nor visits.view.all must not reach the service at
    // all — a 403 rendered after the read is still a read.
    vi.mocked(requireAuth).mockResolvedValue(session(["visits.view.own"]));
    const res = await GET(...get());
    expect(res.status).toBe(403);
    expect(getVitalsTrend).not.toHaveBeenCalled();
  });
});
