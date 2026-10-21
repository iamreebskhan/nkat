/**
 * PATCH /api/superbills/[id] — the units bound (0106).
 *
 * A units count is a whole number from 1 to 99 at the route (PatchSchema), the
 * same bound as the column's CHECK. Below the route the service used to drop
 * any other count rather than refuse it: normalizeUnits left it out, the bill
 * was written {} and repriced at one unit, and the biller was told the edit
 * saved. So the schema's bound was all that stood between a mistyped G0318 ×
 * 150 and a bill silently reset to × 1, and nothing tested it. The service now
 * refuses such a count as well (unitErrors); either way the answer is a 422
 * and nothing written. The route and the service run for real here; only auth
 * and the database are faked.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/billing/predict-superbill.service", () => ({
  predictSuperbill: vi.fn().mockResolvedValue(null),
}));

import { PATCH } from "@/app/api/superbills/[id]/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";
const BILLER = "33333333-3333-4333-8333-333333333333";

const SESSION: Session = {
  userId: BILLER,
  orgId: ORG,
  role: "billing_agent",
  permissions: ["billing.superbills.create"],
  email: "biller@design-partner.test",
};

let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id, status FROM superbill")) return Promise.resolve([{ id: SB, status: "draft" }]);
    // The bill as saved: G0318 × 3.
    if (sql.includes("SELECT cpt_codes, cpt_units FROM superbill")) {
      return Promise.resolve([{ cpt_codes: ["99350", "G0318"], cpt_units: { G0318: 3 } }]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

function patch(body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new Request(`http://localhost/api/superbills/${SB}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ id: SB }) }];
}

const wroteBill = () => calls.some((c) => c.sql.includes("UPDATE superbill"));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  vi.mocked(requireAuth).mockResolvedValue(SESSION);
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("PATCH /api/superbills/[id] — units", () => {
  it.each([150, 100, 0, 2.5])("refuses G0318 × %s with 422, and writes nothing", async (n) => {
    const res = await PATCH(...patch({ patch: { cptUnits: { G0318: n } } }));
    expect(res.status).toBe(422);
    expect((await res.json()).success).toBe(false);
    expect(wroteBill()).toBe(false);
  });

  it("CONTROL — a count in range is written as sent and returned as written", async () => {
    // Without this, the refusals above would pass for any reason the route
    // turned the body away.
    const res = await PATCH(...patch({ patch: { cptUnits: { G0318: 4 } } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.cptUnits).toEqual({ G0318: 4 });
    const write = calls.find((c) => c.sql.includes("UPDATE superbill") && c.sql.includes("cpt_units = "))!;
    expect(write.values).toContain('{"G0318":4}');
  });
});
