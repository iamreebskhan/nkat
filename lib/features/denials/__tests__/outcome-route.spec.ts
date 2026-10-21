/**
 * POST /api/denials/[id]/outcome — what reaches recordOutcome.
 *
 * The route adds `overpaymentAcknowledged` to the outcome schema and hands it
 * on. The field is optional, so the type checker is satisfied whether or not
 * the route passes it — and without it the service refuses every amount above
 * what the denial denied, telling the biller to confirm it as an overpayment
 * they have just confirmed. The page's half (the flag is sent) is held in
 * denial-page-partial-recovery.spec.ts; this is the route's half.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/denials/denial.service", () => ({ recordOutcome: vi.fn() }));

import { POST } from "@/app/api/denials/[id]/outcome/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { recordOutcome } from "@/lib/features/denials/denial.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DENIAL = "d0000000-0000-4000-8000-000000000001";

const session: Session = {
  userId: USER,
  orgId: ORG,
  role: "billing_agent",
  permissions: ["billing.denials.refile"],
  email: "biller@design-partner.test",
};

function post(body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new Request(`http://localhost/api/denials/${DENIAL}/outcome`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ id: DENIAL }) }];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(session);
  vi.mocked(recordOutcome).mockResolvedValue(undefined);
});

describe("POST /api/denials/[id]/outcome", () => {
  it("hands the biller's overpayment confirmation to the service with the amount", async () => {
    const res = await POST(
      ...post({ outcome: "paid", outcomeAmountCents: 500000, overpaymentAcknowledged: true }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(recordOutcome).mock.calls[0]![0]).toEqual({
      orgId: ORG,
      id: DENIAL,
      outcome: "paid",
      amountCents: 500000,
      notes: undefined,
      byUserId: USER,
      overpaymentAcknowledged: true,
    });
  });

  it("CONTROL — sends no confirmation the request did not carry", async () => {
    await POST(...post({ outcome: "partially_paid", outcomeAmountCents: 5000 }));
    const args = vi.mocked(recordOutcome).mock.calls[0]![0];
    expect(args.amountCents).toBe(5000);
    expect(args.overpaymentAcknowledged).toBeUndefined();
  });

  it("CONTROL — refuses a confirmation that is not a boolean, recording nothing", async () => {
    const res = await POST(
      ...post({ outcome: "paid", outcomeAmountCents: 500000, overpaymentAcknowledged: "yes" }),
    );
    expect(res.status).toBe(422);
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});
