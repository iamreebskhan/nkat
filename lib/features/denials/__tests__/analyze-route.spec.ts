/**
 * POST /api/denials/[id]/analyze — what the analyst judges a denial against.
 *
 * The route passed `state: null` and the denial's own timestamp as the date of
 * service. With no state the analyst answers from the CARC heuristic alone
 * (denial-analyst.ts), so it never looked a payer rule up; and a rule chosen
 * by the denial date is the wrong one whenever the policy changed between the
 * visit and the denial. It now passes the bill's date of service and the
 * patient's coverage state (getDenialRuleContext).
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/ai/denial-analyst", () => ({ analyzeDenial: vi.fn() }));
vi.mock("@/lib/features/denials/denial.service", () => ({
  getDenial: vi.fn(),
  getDenialRuleContext: vi.fn(),
  recordAiAnalysis: vi.fn(),
}));

import { POST } from "@/app/api/denials/[id]/analyze/route";
import { analyzeDenial } from "@/lib/ai/denial-analyst";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { getDenial, getDenialRuleContext, recordAiAnalysis } from "@/lib/features/denials/denial.service";
import type { DenialView } from "@/lib/features/denials/denial.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DENIAL = "d0000000-0000-4000-8000-000000000001";
const PAYER = "a0000000-0000-4000-8000-000000000302";

const session: Session = {
  userId: USER,
  orgId: ORG,
  role: "billing_agent",
  permissions: ["billing.denials.log"],
  email: "biller@design-partner.test",
};

/** Denied on 14 Oct, for a visit on the evening of 22 Sep. */
const denial = {
  id: DENIAL, superbillId: "b0000000-0000-4000-8000-000000000001", payerId: PAYER,
  cptCode: "99349", icd10Codes: ["C34.90"], modifiers: [], carcCode: "50", rarcCode: null,
  groupCode: "CO", denialReason: "Not medically necessary", deniedAmountCents: 13700,
  deniedAt: "2026-10-14T15:00:00.000Z",
} as unknown as DenialView;

const run = () =>
  POST(
    new Request(`http://localhost/api/denials/${DENIAL}/analyze`, { method: "POST" }) as unknown as NextRequest,
    { params: Promise.resolve({ id: DENIAL }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(session);
  vi.mocked(getDenial).mockResolvedValue(denial);
  vi.mocked(getDenialRuleContext).mockResolvedValue({ dateOfService: "2026-09-22", state: "OH" });
  vi.mocked(recordAiAnalysis).mockResolvedValue(undefined as never);
  vi.mocked(analyzeDenial).mockResolvedValue({
    text: "t", likelyCause: "c", recommendation: "appeal", citation: null, modelVersion: "m", aiUsed: true,
  });
});

describe("POST /api/denials/[id]/analyze", () => {
  it("judges the denial against the rule in force on the bill's date of service, in the coverage state", async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(vi.mocked(getDenialRuleContext)).toHaveBeenCalledWith({ orgId: ORG, id: DENIAL });
    expect(vi.mocked(analyzeDenial).mock.calls[0]![0]).toMatchObject({
      orgId: ORG,
      payerId: PAYER,
      cptCode: "99349",
      state: "OH",
      dateOfService: "2026-09-22",
    });
  });

  it("CONTROL: never the denial's own date", async () => {
    await run();
    expect(vi.mocked(analyzeDenial).mock.calls[0]![0].dateOfService).not.toBe("2026-10-14");
  });

  it("answers 404 when the denial's bill cannot be read, and analyses nothing", async () => {
    vi.mocked(getDenialRuleContext).mockResolvedValue(null);
    const res = await run();
    expect(res.status).toBe(404);
    expect(vi.mocked(analyzeDenial)).not.toHaveBeenCalled();
    expect(vi.mocked(recordAiAnalysis)).not.toHaveBeenCalled();
  });
});
