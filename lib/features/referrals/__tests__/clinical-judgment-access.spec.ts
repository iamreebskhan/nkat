/**
 * Triage and acuity stay clinical (Level-1 doc:26: "a nurse or other clinical
 * team member"). The triage route took patients.edit, on the reasoning that only
 * clinicians held it; the intake role was then given patients.edit to correct
 * demographics and insurance, and could record triage. Found by signing in as
 * one and seeing the button.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/referrals/referral.service", () => ({
  addReferralTriage: vi.fn(),
  referralTriageAcuity: vi.fn(),
}));
vi.mock("@/lib/features/patients/patient.service", () => ({
  createPatient: vi.fn(),
  listPatients: vi.fn(),
  searchPatients: vi.fn(),
}));

import { POST as createPost } from "@/app/api/patients/route";
import { POST as triagePost } from "@/app/api/referrals/[id]/triage/route";
import { fail } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { createPatient } from "@/lib/features/patients/patient.service";
import { addReferralTriage, referralTriageAcuity } from "@/lib/features/referrals/referral.service";
import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFERRAL = "c0000000-0000-4000-8000-00000000000c";

/** requireAuth as it decides: the session's grants against what the route names. */
const as = (role: keyof typeof ROLE_DEFAULT_PERMISSIONS) => {
  const permissions = ROLE_DEFAULT_PERMISSIONS[role];
  vi.mocked(requireAuth).mockImplementation(async (needed: string[] = []) =>
    needed.every((p) => permissions.includes(p))
      ? ({ userId: ME, orgId: ORG, role, permissions, email: "x@example.test" } as never)
      : (fail("Permission denied", { status: 403 }) as never),
  );
};

const req = (body: unknown) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

const triage = () =>
  triagePost(req({ symptoms: "Pain", preliminaryAcuity: "high" }), {
    params: Promise.resolve({ id: REFERRAL }),
  });

const patient = (clinical: Record<string, unknown>, referralId?: string) =>
  createPost(
    req({
      demographics: { firstName: "Nora", lastName: "Test", dateOfBirth: "1950-05-05" },
      insurance: {},
      clinical,
      consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: false },
      careTeam: {},
      ...(referralId && { referralId }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addReferralTriage).mockResolvedValue({ id: "t1" } as never);
  vi.mocked(createPatient).mockResolvedValue({ id: "p1" } as never);
  vi.mocked(referralTriageAcuity).mockResolvedValue(null);
});

describe("POST /api/referrals/[id]/triage", () => {
  it("refuses the intake coordinator, who may correct the referral and not judge it", async () => {
    as("intake_coordinator");
    expect((await triage()).status).toBe(403);
    expect(addReferralTriage).not.toHaveBeenCalled();
  });

  it("CONTROL: a clinician records it", async () => {
    as("clinician");
    expect((await triage()).status).toBe(201);
    expect(addReferralTriage).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/patients: the acuity on a new chart", () => {
  it("refuses an acuity the intake coordinator gave themselves", async () => {
    as("intake_coordinator");
    expect((await patient({ acuity: "high" })).status).toBe(403);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("lets them carry the triage's across at admission: it was the nurse's judgment", async () => {
    as("intake_coordinator");
    vi.mocked(referralTriageAcuity).mockResolvedValue("high");
    expect((await patient({ acuity: "high" }, REFERRAL)).status).toBe(201);
    expect(vi.mocked(referralTriageAcuity).mock.calls[0]![0]).toEqual({ orgId: ORG, referralId: REFERRAL });
  });

  it("refuses a different one on the same referral", async () => {
    as("intake_coordinator");
    vi.mocked(referralTriageAcuity).mockResolvedValue("low");
    expect((await patient({ acuity: "critical" }, REFERRAL)).status).toBe(403);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("CONTROL: a new chart with no acuity is theirs to open", async () => {
    as("intake_coordinator");
    expect((await patient({})).status).toBe(201);
    expect(referralTriageAcuity).not.toHaveBeenCalled();
  });

  it("CONTROL: a clinician gives one freely", async () => {
    as("clinician");
    const res = await patient({ acuity: "high" });
    // The clinician template cannot open a chart at all; an admin can.
    expect(res.status).toBe(403);
    as("org_admin");
    expect((await patient({ acuity: "high" })).status).toBe(201);
    expect(referralTriageAcuity).not.toHaveBeenCalled();
  });
});
