/**
 * A "Not billed" visit type never gets a bill (audit R18).
 *
 * buildDraftFromVisit is the one door every bill comes through: the visit's
 * bill page, Create Bill on the billing side, and the sign-off auto-draft. The
 * transition already refuses documented -> pending_billing for these visits,
 * but Create Bill needs no transition, so the refusal has to live here too.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text, matching pricing.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/billing/predict-superbill.service", () => ({
  predictSuperbill: vi.fn().mockResolvedValue(null),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

import { buildDraftFromVisit } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000c";

let visitRow: Record<string, unknown>;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM visit v") && sql.includes("clinician_npi")) {
      // The org's zone comes back only if the statement selects it (0107).
      const row = { ...visitRow };
      if (!sql.includes("o.timezone AS org_timezone")) delete row.org_timezone;
      return Promise.resolve([row]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const build = () => buildDraftFromVisit({ orgId: ORG, visitId: VISIT });

beforeEach(() => {
  calls = [];
  // A signed bereavement follow-up on a type the org marked Not billed. No
  // payer, so a billable control prices from the reference table without a
  // rate lookup.
  visitRow = {
    id: VISIT, status: "documented", patient_id: "p1", is_telehealth: false,
    cpt_codes_assigned: [], icd10_codes: ["Z63.4"], modifiers: [],
    scheduled_start: null, start_time: new Date("2026-09-09T15:00:00Z"),
    primary_payer_id: null, primary_member_id: "M1", primary_diagnosis_icd10: null,
    clinician_npi: "1234567893", credential: "NP", org_npi: null, full_name: "Jane NP",
    coverage_state: "OH", place_of_service_code: "12", pos_facility: "non_facility",
    coding_basis: "non_billable", org_timezone: "America/New_York",
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("buildDraftFromVisit — a Not billed visit type (audit R18)", () => {
  it("refuses a signed visit on a Not billed type with a ValidationError (422)", async () => {
    await expect(build()).rejects.toBeInstanceOf(ValidationError);
    await expect(build()).rejects.toThrow(/not billed/i);
  });

  it("tells an unsigned one it is not billed, not that it needs signing to be billed", async () => {
    visitRow = { ...visitRow, status: "in_progress" };
    const err = await build().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/not billed/i);
    expect((err as Error).message).not.toMatch(/has not been signed/);
  });

  it("CONTROL — the same signed visit on a billable band builds its draft", async () => {
    visitRow = { ...visitRow, coding_basis: "established_patient_home", cpt_codes_assigned: ["99349"] };
    const d = await build();
    expect(d.cptCodes).toEqual(["99349"]);
  });

  it("CONTROL — a visit whose slug has no type row (pre-0062) still builds", async () => {
    visitRow = { ...visitRow, coding_basis: null, cpt_codes_assigned: ["99349"] };
    const d = await build();
    expect(d.cptCodes).toEqual(["99349"]);
  });

  it("CONTROL — the signed-status guard still refuses an unsigned billable visit", async () => {
    visitRow = { ...visitRow, status: "in_progress", coding_basis: "established_patient_home" };
    await expect(build()).rejects.toThrow(/has not been signed/);
  });

  it("reads the band from the org's own visit type, in the same query", async () => {
    await build().catch(() => {});
    const q = calls.find((c) => c.sql.includes("clinician_npi"))!;
    expect(q.sql).toMatch(
      /SELECT ot\.coding_basis FROM org_visit_type ot\s+WHERE ot\.org_id = v\.org_id AND ot\.slug = v\.visit_type/,
    );
  });
});
