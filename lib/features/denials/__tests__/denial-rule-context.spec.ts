/**
 * getDenialRuleContext — the bill's date of service and the coverage state a
 * denial is analysed against (see analyze-route.spec.ts for why).
 *
 * Run against sql-fake over tables holding two orgs and no RLS, other org's
 * rows first, so a join or a WHERE that forgets the org meets them first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { fakeTx, type FakeDb } from "@/lib/features/team/__tests__/sql-fake";

import { getDenialRuleContext } from "../denial.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const DENIAL = "d0000000-0000-4000-8000-000000000001";
const THEIR_DENIAL = "d0000000-0000-4000-8000-0000000000f1";
const BILL = "b0000000-0000-4000-8000-000000000001";
const PATIENT = "f0000000-0000-4000-8000-000000000001";

let db: FakeDb;

beforeEach(() => {
  db = {
    superbill_denial: {
      columns: ["id", "org_id", "superbill_id"],
      rows: [
        { id: THEIR_DENIAL, org_id: OTHER_ORG, superbill_id: BILL },
        { id: DENIAL, org_id: ORG, superbill_id: BILL },
      ],
    },
    superbill: {
      columns: ["id", "org_id", "patient_id", "date_of_service"],
      rows: [
        { id: BILL, org_id: OTHER_ORG, patient_id: PATIENT, date_of_service: new Date("2026-01-01T00:00:00Z") },
        // A DATE, as Prisma returns one: UTC midnight of the stored day.
        { id: BILL, org_id: ORG, patient_id: PATIENT, date_of_service: new Date("2026-09-22T00:00:00Z") },
      ],
    },
    patient: {
      columns: ["id", "org_id", "insurance_state", "state"],
      rows: [
        { id: PATIENT, org_id: OTHER_ORG, insurance_state: "NC", state: "NC" },
        { id: PATIENT, org_id: ORG, insurance_state: "OH", state: "KY" },
      ],
    },
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx(db)),
  );
});

describe("getDenialRuleContext", () => {
  it("reads the bill's date of service as stored and the coverage state, within the org", async () => {
    expect(await getDenialRuleContext({ orgId: ORG, id: DENIAL })).toEqual({
      dateOfService: "2026-09-22",
      state: "OH",
    });
  });

  it("falls back to the address state for a patient recorded before insurance_state", async () => {
    db.patient!.rows[1]!.insurance_state = null;
    expect((await getDenialRuleContext({ orgId: ORG, id: DENIAL }))?.state).toBe("KY");
  });

  it("does not read another org's denial", async () => {
    expect(await getDenialRuleContext({ orgId: ORG, id: THEIR_DENIAL })).toBeNull();
  });
});
