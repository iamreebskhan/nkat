/**
 * The service refuses a payer × coverage-state pair the payer does not serve
 * (audit R37), on every path into the patient row: create with a policy
 * state, create relying on the address-state fallback, and a PATCH that
 * changes only one half of the pair.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { createPatient, updatePatient } from "../patient.service";
import { CreatePatientSchema } from "../patient.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const CREATOR = "55555555-5555-4555-8555-555555555555";
const CARESOURCE_OH = "a0000000-0000-4000-8000-000000000305";
const ATC_SC = "a0000000-0000-4000-8000-000000000201";
const AETNA = "a0000000-0000-4000-8000-000000000101";

const PAYERS: Record<string, { name: string; states_served: string[] }> = {
  [CARESOURCE_OH]: { name: "CareSource Ohio", states_served: ["OH"] },
  [ATC_SC]: { name: "Absolute Total Care", states_served: ["SC"] },
  [AETNA]: { name: "Aetna", states_served: ["OH", "NC", "SC"] },
};
const KNOWN_STATES = ["OH", "NC", "SC", "UT"];

/** The patient row as stored, for updates. */
let stored: { primary_payer_id: string | null; insurance_state: string | null; state: string | null };
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM payer")) {
      const p = PAYERS[values[0] as string];
      return Promise.resolve(p ? [p] : []);
    }
    if (sql.includes("FROM state")) {
      return Promise.resolve(KNOWN_STATES.includes(values[0] as string) ? [{ ok: 1 }] : []);
    }
    if (sql.includes("primary_payer_id, insurance_state, state FROM patient")) {
      return Promise.resolve([stored]);
    }
    if (sql.includes("INSERT INTO patient")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("SELECT id FROM patient")) return Promise.resolve([{ id: PATIENT }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const inserted = () => calls.some((c) => c.sql.includes("INSERT INTO patient"));
const updatedInsurance = () =>
  calls.some((c) => c.sql.includes("UPDATE patient SET") && c.sql.includes("insurance_state = COALESCE"));

function payload(insurance: Record<string, unknown>, addressState?: string) {
  return CreatePatientSchema.parse({
    demographics: {
      firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1942-03-08",
      ...(addressState ? { state: addressState } : {}),
    },
    insurance,
    clinical: {},
    consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true },
    careTeam: {},
  });
}

type UpdatePayload = Parameters<typeof updatePatient>[0]["payload"];

beforeEach(() => {
  calls = [];
  stored = { primary_payer_id: null, insurance_state: null, state: "OH" };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("createPatient — coverage pair", () => {
  it("refuses a policy state the payer does not cover, and writes nothing", async () => {
    await expect(
      createPatient({
        orgId: ORG, createdByUserId: CREATOR,
        payload: payload({ primaryPayerId: CARESOURCE_OH, insuranceState: "UT" }),
      }),
    ).rejects.toThrow("CareSource Ohio does not cover UT. It covers OH.");
    expect(inserted()).toBe(false);
  });

  it("checks the address-state fallback too — the state that will actually be stored", async () => {
    await expect(
      createPatient({
        orgId: ORG, createdByUserId: CREATOR,
        payload: payload({ primaryPayerId: CARESOURCE_OH }, "UT"),
      }),
    ).rejects.toThrow(/does not cover UT/);
    expect(inserted()).toBe(false);
  });

  it("CONTROL — a covered pair is created", async () => {
    const r = await createPatient({
      orgId: ORG, createdByUserId: CREATOR,
      payload: payload({ primaryPayerId: CARESOURCE_OH, insuranceState: "OH" }),
    });
    expect(r.id).toBe(PATIENT);
    expect(inserted()).toBe(true);
  });

  it("refuses an unknown payer", async () => {
    await expect(
      createPatient({
        orgId: ORG, createdByUserId: CREATOR,
        payload: payload({ primaryPayerId: "a0000000-0000-4000-8000-00000000dead", insuranceState: "OH" }),
      }),
    ).rejects.toThrow(/Unknown payer/);
  });

  it("refuses a state code that does not exist, even with no payer", async () => {
    await expect(
      createPatient({
        orgId: ORG, createdByUserId: CREATOR,
        payload: payload({ insuranceState: "ZZ" }),
      }),
    ).rejects.toThrow(/Unknown state code "ZZ"/);
    expect(inserted()).toBe(false);
  });
});

describe("updatePatient — the pair as it will stand after the update", () => {
  it("refuses switching to a payer that does not cover the stored state", async () => {
    stored = { primary_payer_id: CARESOURCE_OH, insurance_state: "OH", state: "OH" };
    await expect(
      updatePatient({
        orgId: ORG, id: PATIENT,
        payload: { insurance: { primaryPayerId: ATC_SC } } as UpdatePayload,
      }),
    ).rejects.toThrow("Absolute Total Care does not cover OH. It covers SC.");
    expect(updatedInsurance()).toBe(false);
  });

  it("refuses changing only the state to one the stored payer does not cover", async () => {
    stored = { primary_payer_id: CARESOURCE_OH, insurance_state: "OH", state: "OH" };
    await expect(
      updatePatient({
        orgId: ORG, id: PATIENT,
        payload: { insurance: { insuranceState: "NC" } } as UpdatePayload,
      }),
    ).rejects.toThrow(/CareSource Ohio does not cover NC/);
  });

  it("CONTROL — a state the stored payer covers is saved", async () => {
    stored = { primary_payer_id: AETNA, insurance_state: "OH", state: "OH" };
    const r = await updatePatient({
      orgId: ORG, id: PATIENT,
      payload: { insurance: { insuranceState: "NC" } } as UpdatePayload,
    });
    expect(r.updated).toBe(true);
    expect(updatedInsurance()).toBe(true);
  });

  it("does not look the pair up for an update that leaves insurance alone", async () => {
    await updatePatient({
      orgId: ORG, id: PATIENT,
      payload: { demographics: { firstName: "Ada" } } as UpdatePayload,
    });
    expect(calls.some((c) => c.sql.includes("FROM payer"))).toBe(false);
  });
});
