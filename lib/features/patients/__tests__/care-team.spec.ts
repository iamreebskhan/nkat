/**
 * Unit tests for per-patient care-team assignment (migration 0054).
 *
 * Deterministic — lib/db is mocked with a fake tx that dispatches on the
 * SQL text and records every call, so we can assert:
 *   1. schema semantics (create = optional uuids; PATCH = tri-state),
 *   2. org-membership enforcement (a non-member assignee throws),
 *   3. the tri-state UPDATE (absent = keep, null = clear, uuid = set),
 *   4. persistence of assignments through createPatient's INSERT.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { createPatient, updatePatient } from "../patient.service";
import {
  CareTeamSchema,
  CreatePatientSchema,
  UpdateCareTeamSchema,
} from "../patient.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const NP = "22222222-2222-4222-8222-222222222222";
const RN = "33333333-3333-4333-8333-333333333333";
const OUTSIDER = "99999999-9999-4999-8999-999999999999";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const CREATOR = "55555555-5555-4555-8555-555555555555";

/** Calls recorded as { sql, values } for assertions. */
let calls: { sql: string; values: unknown[] }[] = [];
/** user_ids the fake org_member table "contains". */
let orgMembers: string[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM org_member")) {
      const asked = (values[0] as string[]) ?? [];
      return Promise.resolve(
        asked.filter((id) => orgMembers.includes(id)).map((user_id) => ({ user_id })),
      );
    }
    if (sql.includes("INSERT INTO patient")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("SELECT id FROM patient")) return Promise.resolve([{ id: PATIENT }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  orgMembers = [NP, RN];
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const BASE_PAYLOAD = {
  demographics: { firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1942-03-08" },
  insurance: {},
  clinical: {},
  consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true },
  careTeam: {},
};

describe("care-team schemas", () => {
  it("create schema keeps `careTeam: {}` senders valid and accepts uuids", () => {
    expect(CreatePatientSchema.safeParse(BASE_PAYLOAD).success).toBe(true);
    expect(CareTeamSchema.safeParse({ primaryNpUserId: NP, rnUserId: RN }).success).toBe(true);
    expect(CareTeamSchema.safeParse({ primaryNpUserId: "not-a-uuid" }).success).toBe(false);
    // create schema has no null — absent simply means unassigned
    expect(CareTeamSchema.safeParse({ primaryNpUserId: null }).success).toBe(false);
  });

  it("PATCH schema is tri-state: absent, null (clear), or uuid", () => {
    expect(UpdateCareTeamSchema.safeParse({}).success).toBe(true);
    expect(UpdateCareTeamSchema.safeParse({ rnUserId: null }).success).toBe(true);
    expect(UpdateCareTeamSchema.safeParse({ rnUserId: RN }).success).toBe(true);
    expect(UpdateCareTeamSchema.safeParse({ rnUserId: "nope" }).success).toBe(false);
  });
});

describe("createPatient care-team persistence", () => {
  it("validates membership and passes assignments into the INSERT", async () => {
    await createPatient({
      orgId: ORG,
      createdByUserId: CREATOR,
      payload: { ...BASE_PAYLOAD, careTeam: { primaryNpUserId: NP, rnUserId: RN } },
    });
    const membership = calls.find((c) => c.sql.includes("FROM org_member"));
    expect(membership?.values[0]).toEqual([NP, RN]);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO patient"));
    expect(insert?.sql).toContain("primary_np_user_id");
    expect(insert?.values).toContain(NP);
    expect(insert?.values).toContain(RN);
  });

  it("rejects an assignee who is not an org member", async () => {
    await expect(
      createPatient({
        orgId: ORG,
        createdByUserId: CREATOR,
        payload: { ...BASE_PAYLOAD, careTeam: { socialWorkerUserId: OUTSIDER } },
      }),
    ).rejects.toThrow(/not an active member of this organization/);
    expect(calls.some((c) => c.sql.includes("INSERT INTO patient"))).toBe(false);
  });

  it("skips the membership query entirely when no one is assigned", async () => {
    await createPatient({ orgId: ORG, createdByUserId: CREATOR, payload: BASE_PAYLOAD });
    expect(calls.some((c) => c.sql.includes("FROM org_member"))).toBe(false);
  });
});

describe("updatePatient care-team tri-state", () => {
  it("absent = keep, null = clear, uuid = set (CASE flags in the UPDATE)", async () => {
    await updatePatient({
      orgId: ORG,
      id: PATIENT,
      payload: { careTeam: { primaryNpUserId: NP, rnUserId: null } },
    });
    const upd = calls.find((c) => c.sql.includes("primary_np_user_id"));
    expect(upd).toBeDefined();
    // Value order in the UPDATE: [npProvided?, npValue, rnProvided?, rnValue,
    // swProvided?, swValue, baProvided?, baValue] — the boolean is
    // `field === undefined` (true means KEEP the stored value).
    expect(upd!.values[0]).toBe(false); // np provided
    expect(upd!.values[1]).toBe(NP); //    → set
    expect(upd!.values[2]).toBe(false); // rn provided
    expect(upd!.values[3]).toBe(null); //  → clear
    expect(upd!.values[4]).toBe(true); //  sw absent → keep
    expect(upd!.values[6]).toBe(true); //  ba absent → keep
  });

  it("rejects reassignment to a non-member", async () => {
    await expect(
      updatePatient({
        orgId: ORG,
        id: PATIENT,
        payload: { careTeam: { billingAgentUserId: OUTSIDER } },
      }),
    ).rejects.toThrow(/not an active member of this organization/);
    expect(calls.some((c) => c.sql.includes("billing_agent_user_id ¶") || c.sql.includes("UPDATE patient"))).toBe(false);
  });

  it("careTeam: {} is a no-op — no UPDATE, no updated_at bump", async () => {
    await updatePatient({ orgId: ORG, id: PATIENT, payload: { careTeam: {} } });
    expect(calls.some((c) => c.sql.includes("primary_np_user_id"))).toBe(false);
  });

  it("clear-only PATCH (all nulls) skips membership check but updates", async () => {
    await updatePatient({
      orgId: ORG,
      id: PATIENT,
      payload: { careTeam: { primaryNpUserId: null, rnUserId: null } },
    });
    expect(calls.some((c) => c.sql.includes("FROM org_member"))).toBe(false);
    const upd = calls.find((c) => c.sql.includes("primary_np_user_id"));
    expect(upd!.values[0]).toBe(false); // np provided → clear
    expect(upd!.values[1]).toBe(null);
  });
});
