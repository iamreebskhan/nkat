/**
 * Intake telehealth consent (audit R22).
 *
 * The consent step's telehealth box used to be validated and then thrown
 * away. createPatient now stamps patient.telehealth_consent_at, and
 * intakeTelehealthConsentFor decides which visits it pre-ticks on the
 * document page. lib/db is mocked with a fake tx that records every call, as
 * in care-team.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { createPatient } from "../patient.service";
import { intakeTelehealthConsentFor, type CreatePatient } from "../patient.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const CREATOR = "55555555-5555-4555-8555-555555555555";

let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("INSERT INTO patient")) return Promise.resolve([{ id: PATIENT }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

function payload(telehealthConsent: boolean): CreatePatient {
  return {
    demographics: { firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1942-03-08" },
    insurance: {},
    clinical: {},
    consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent },
    careTeam: {},
  };
}

/** The value bound to telehealth_consent_at: the only one cast ::timestamptz. */
function consentValue(): unknown {
  const insert = calls.find((c) => c.sql.includes("INSERT INTO patient"));
  expect(insert?.sql).toContain("telehealth_consent_at");
  const parts = insert!.sql.split("¶");
  expect(parts.filter((s) => s.startsWith("::timestamptz"))).toHaveLength(1);
  const k = parts.findIndex((s, i) => i > 0 && s.startsWith("::timestamptz"));
  // parts[k] is the SQL after value k - 1.
  return insert!.values[k - 1];
}

describe("createPatient records intake telehealth consent", () => {
  it("stamps telehealth_consent_at with the intake time when the box is ticked", async () => {
    const before = Date.now();
    await createPatient({ orgId: ORG, createdByUserId: CREATOR, payload: payload(true) });
    const v = consentValue();
    expect(v).toBeInstanceOf(Date);
    expect((v as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((v as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("CONTROL: sends null when the box is left unticked", async () => {
    await createPatient({ orgId: ORG, createdByUserId: CREATOR, payload: payload(false) });
    expect(consentValue()).toBeNull();
  });
});

describe("intakeTelehealthConsentFor", () => {
  const AT = "2026-09-01T14:00:00.000Z";
  const OPEN_TELEHEALTH = {
    status: "scheduled",
    isTelehealth: true,
    visitTypeIsTelehealth: false,
    telehealthConsentDocumented: false,
  };

  it("pre-ticks an open telehealth visit that has no consent of its own", () => {
    expect(intakeTelehealthConsentFor(OPEN_TELEHEALTH, { telehealthConsentAt: AT })).toBe(AT);
    expect(
      intakeTelehealthConsentFor({ ...OPEN_TELEHEALTH, status: "in_progress" }, { telehealthConsentAt: AT }),
    ).toBe(AT);
    // Telehealth by its visit type alone counts too.
    expect(
      intakeTelehealthConsentFor(
        { ...OPEN_TELEHEALTH, isTelehealth: false, visitTypeIsTelehealth: true },
        { telehealthConsentAt: AT },
      ),
    ).toBe(AT);
  });

  it("CONTROL: a signed visit shows only what was attested", () => {
    for (const status of ["documented", "pending_billing", "billed", "cancelled"]) {
      expect(
        intakeTelehealthConsentFor({ ...OPEN_TELEHEALTH, status }, { telehealthConsentAt: AT }),
      ).toBeNull();
    }
  });

  it("CONTROL: leaves in-person visits, answered visits and patients with no intake consent alone", () => {
    expect(
      intakeTelehealthConsentFor({ ...OPEN_TELEHEALTH, isTelehealth: false }, { telehealthConsentAt: AT }),
    ).toBeNull();
    expect(
      intakeTelehealthConsentFor(
        { ...OPEN_TELEHEALTH, telehealthConsentDocumented: true },
        { telehealthConsentAt: AT },
      ),
    ).toBeNull();
    expect(intakeTelehealthConsentFor(OPEN_TELEHEALTH, { telehealthConsentAt: null })).toBeNull();
  });
});
