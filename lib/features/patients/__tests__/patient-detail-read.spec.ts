/**
 * What the patient detail read carries for the document page.
 *
 * - Payer type (audit R17 follow-up). The page picked G0318 vs 99417 by
 *   finding the patient's payer in the payer list, which R17 made
 *   active-only, so a withdrawn Medicare Advantage plan fell out of it and its
 *   patients were offered 99417. getPatient now selects pay.payer_type from
 *   its own payer join, which has no active filter.
 * - Intake telehealth consent (audit R22), which pre-ticks the visit's box.
 *
 * List reads select neither and carry null. lib/db is mocked with a fake tx
 * that records every call, as in care-team.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { getPatient, listPatients } from "../patient.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const PAYER = "66666666-6666-4666-8666-666666666666";
const CONSENT_AT = "2026-09-01T14:00:00.000Z";

let calls: { sql: string; values: unknown[] }[] = [];
/** The row the detail SELECT returns, as Postgres would shape it. */
let detailRow: Record<string, unknown> = {};

/** A patient row with the columns every read selects. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PATIENT,
    first_name: "Ada",
    last_name: "Lovelace",
    date_of_birth: new Date("1942-03-08T00:00:00Z"),
    sex_assigned_at_birth: null,
    address_line_1: null,
    city: null,
    state: "OH",
    zip: null,
    phone: null,
    primary_payer_id: null,
    primary_member_id: null,
    insurance_state: "OH",
    primary_diagnosis_icd10: null,
    acuity: null,
    last_visit_date: null,
    next_visit_date: null,
    primary_np_user_id: null,
    rn_user_id: null,
    social_worker_user_id: null,
    billing_agent_user_id: null,
    status: "active",
    created_at: new Date("2026-09-01T14:00:00Z"),
    updated_at: new Date("2026-09-01T14:00:00Z"),
    ...over,
  };
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("LEFT JOIN payer pay")) return Promise.resolve([detailRow]);
    if (sql.includes("COUNT(*)")) return Promise.resolve([{ n: BigInt(1) }]);
    if (sql.includes("FROM patient")) return Promise.resolve([row()]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  detailRow = row();
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("getPatient payer type (audit R17)", () => {
  it("returns the payer type for a patient whose payer has been withdrawn", async () => {
    detailRow = row({
      primary_payer_id: PAYER,
      primary_payer_name: "Withdrawn MA Plan",
      primary_payer_type: "medicare_advantage_org",
    });
    const view = await getPatient({ orgId: ORG, id: PATIENT });
    expect(view?.primaryPayerType).toBe("medicare_advantage_org");
    const q = calls.find((c) => c.sql.includes("LEFT JOIN payer pay"))!;
    expect(q.sql).toContain("pay.payer_type AS primary_payer_type");
    // Nothing narrows the join to active payers: a withdrawn one still
    // covers the patients already on it.
    expect(q.sql).not.toMatch(/pay\.active/);
  });

  it("CONTROL: a patient with no payer gives null", async () => {
    detailRow = row({ primary_payer_name: null, primary_payer_type: null });
    const view = await getPatient({ orgId: ORG, id: PATIENT });
    expect(view?.primaryPayerId).toBeNull();
    expect(view?.primaryPayerType).toBeNull();
    expect(view?.primaryPayerProlongedCode).toBeNull();
  });

  it("returns the prolonged-service code the payer's record names (0108)", async () => {
    detailRow = row({
      primary_payer_id: PAYER,
      primary_payer_type: "medicaid_mco",
      primary_payer_prolonged_code: "G0318",
    });
    const view = await getPatient({ orgId: ORG, id: PATIENT });
    expect(view?.primaryPayerProlongedCode).toBe("G0318");
    const q = calls.find((c) => c.sql.includes("LEFT JOIN payer pay"))!;
    expect(q.sql).toContain("pay.prolonged_service_code AS primary_payer_prolonged_code");
  });
});

describe("getPatient intake telehealth consent (audit R22)", () => {
  it("selects telehealth_consent_at and returns it as an ISO timestamp", async () => {
    detailRow = row({ telehealth_consent_at: new Date(CONSENT_AT) });
    const view = await getPatient({ orgId: ORG, id: PATIENT });
    expect(view?.telehealthConsentAt).toBe(CONSENT_AT);
    const q = calls.find((c) => c.sql.includes("LEFT JOIN payer pay"))!;
    expect(q.sql).toContain("patient.telehealth_consent_at");
  });

  it("CONTROL: no consent recorded gives null", async () => {
    detailRow = row({ telehealth_consent_at: null });
    const view = await getPatient({ orgId: ORG, id: PATIENT });
    expect(view?.telehealthConsentAt).toBeNull();
  });
});

describe("list reads", () => {
  it("carry null for both, since they select neither column", async () => {
    const { rows } = await listPatients({ orgId: ORG });
    expect(rows).toHaveLength(1);
    expect(rows[0].primaryPayerType).toBeNull();
    expect(rows[0].primaryPayerProlongedCode).toBeNull();
    expect(rows[0].telehealthConsentAt).toBeNull();
  });
});
