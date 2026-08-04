/**
 * Insurance schema — the payer + coverage-state pair that every payer-rule
 * lookup keys on. Client walkthrough [01:27]: "insurance organization ki ho,
 * us ki bhi state ho". Before this, the payer was a raw UUID text box, so in
 * practice it was never set and coverage rules silently never engaged.
 */
import { describe, expect, it } from "vitest";

import { CreatePatientSchema, InsuranceSchema } from "../patient.types";

const PAYER = "a0000000-0000-4000-8000-000000000401";

describe("InsuranceSchema", () => {
  it("accepts a payer + state pair", () => {
    const r = InsuranceSchema.safeParse({ primaryPayerId: PAYER, insuranceState: "OH" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.insuranceState).toBe("OH");
  });

  it("upper-cases the state so lookups match the rule table", () => {
    const r = InsuranceSchema.safeParse({ primaryPayerId: PAYER, insuranceState: "oh" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.insuranceState).toBe("OH");
  });

  it("rejects a malformed state", () => {
    expect(InsuranceSchema.safeParse({ insuranceState: "Ohio" }).success).toBe(false);
    expect(InsuranceSchema.safeParse({ insuranceState: "O" }).success).toBe(false);
    expect(InsuranceSchema.safeParse({ insuranceState: "12" }).success).toBe(false);
  });

  it("rejects a non-uuid payer (the old free-text box let anything through)", () => {
    expect(InsuranceSchema.safeParse({ primaryPayerId: "Aetna" }).success).toBe(false);
  });

  it("still allows an empty insurance block — intake without insurance is real", () => {
    expect(InsuranceSchema.safeParse({}).success).toBe(true);
  });
});

describe("CreatePatientSchema with insurance", () => {
  const base = {
    demographics: { firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1942-03-08" },
    clinical: {},
    consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true },
    careTeam: {},
  };

  it("carries payer + coverage state through the full create payload", () => {
    const r = CreatePatientSchema.safeParse({
      ...base,
      insurance: { primaryPayerId: PAYER, insuranceState: "nc", primaryMemberId: "W1" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.insurance.primaryPayerId).toBe(PAYER);
      expect(r.data.insurance.insuranceState).toBe("NC");
    }
  });
});
