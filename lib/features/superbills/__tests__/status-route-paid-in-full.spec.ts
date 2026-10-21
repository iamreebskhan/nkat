/**
 * POST /api/superbills/[id]/status — the "paid in full" assertion reaches the
 * claim.
 *
 * The queue decides "this payment covers the bill" from its own fetched row,
 * and that row goes stale: a denied claim can be repriced UP and resubmitted
 * in another tab. markStatusTx refuses a paid-in-full move the claim's billed
 * amount does not support (mark-status.spec.ts), but only when the flag
 * arrives. The route validates with zod, which STRIPS any key its schema does
 * not name, so dropping `paidInFull` from the schema or from the markStatus
 * call switches that refusal off without a type error — and the stale click
 * then closes a $250.00 claim as paid at $200.00, a final status, with the
 * remaining $50.00 unrecordable. The route and the service run for real here;
 * only auth and the database are faked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { POST } from "@/app/api/superbills/[id]/status/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";
const BILLER = "33333333-3333-4333-8333-333333333333";
const VISIT = "e0000000-0000-4000-8000-00000000000c";

const SESSION: Session = {
  userId: BILLER,
  orgId: ORG,
  role: "billing_agent",
  permissions: ["billing.superbills.edit"],
  email: "biller@design-partner.test",
};

/** What the claim bills NOW — after the reprice the open queue never saw. */
let billed: number;
let calls: string[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray) => {
    const sql = strings.join("¶");
    calls.push(sql);
    if (sql.includes("SELECT status, provider_npi, visit_id FROM superbill")) {
      return Promise.resolve([{ status: "submitted", provider_npi: "1234567893", visit_id: VISIT }]);
    }
    if (sql.includes("SELECT billed_amount_cents FROM superbill")) {
      return Promise.resolve([{ billed_amount_cents: BigInt(billed) }]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

function post(body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new Request(`http://localhost/api/superbills/${SB}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ id: SB }) }];
}

const wrote = () => ({
  payment: calls.some((s) => s.includes("paid_at")),
  trail: calls.some((s) => s.includes("INSERT INTO superbill_activity")),
  audit: calls.some((s) => s.includes("INSERT INTO audit_log")),
});

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  billed = 25000;
  vi.mocked(requireAuth).mockResolvedValue(SESSION);
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("POST /api/superbills/[id]/status — paid in full", () => {
  it("refuses a stale paid-in-full click with 422, names the real bill, and writes nothing", async () => {
    // The queue row still says $200.00; the claim bills $250.00.
    const res = await POST(...post({ to: "paid", paidAmountCents: 20000, paidInFull: true }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("cannot be recorded as paid in full");
    expect(body.error).toContain("$250.00");
    expect(wrote()).toEqual({ payment: false, trail: false, audit: false });
  });

  it("CONTROL — the same body without the assertion is recorded, so the refusal above is the flag's", async () => {
    // A payment short of the bill is ordinary (a contractual adjustment); only
    // the in-full claim is held to the bill. Without this, the test above would
    // pass for any reason the route refused the body.
    const res = await POST(...post({ to: "paid", paidAmountCents: 20000 }));
    expect(res.status).toBe(200);
    expect(wrote()).toEqual({ payment: true, trail: true, audit: true });
  });

  it("CONTROL — a paid-in-full click that does cover the bill is recorded", async () => {
    const res = await POST(...post({ to: "paid", paidAmountCents: 25000, paidInFull: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ from: "submitted", to: "paid" });
  });
});

describe("the queue page makes that assertion on every paid it posts", () => {
  // Nothing under app/ runs in vitest, so this reads the page. Every move to
  // 'paid' the queue posts is an in-full claim made against a fetched row —
  // "Record paid in full" sends the row's billed figure, and a typed amount
  // that reaches it is sent as paid — so if the page stopped sending the flag,
  // the route and service above would never see a claim to check.
  const page = readFileSync(join(process.cwd(), "app/(platform)/billing/superbills/page.tsx"), "utf8");

  it("sends paidInFull whenever the status it posts is paid", () => {
    expect(page).toMatch(/\.\.\.\(\s*to\s*===\s*"paid"\s*\?\s*\{\s*paidInFull:\s*true\s*\}\s*:\s*\{\s*\}\s*\)/);
  });
});
