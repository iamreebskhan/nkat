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
/** A second tenant, whose active members are nobody here. */
const OTHER_ORG = "aaaa1111-1111-4111-8111-111111111111";
const NP = "22222222-2222-4222-8222-222222222222";
const RN = "33333333-3333-4333-8333-333333333333";
/** Still on the roster, but suspended — not someone a chart may name. */
const SUSPENDED = "66666666-6666-4666-8666-666666666666";
/** An active member of OTHER_ORG, invisible here. */
const STRANGER = "77777777-7777-4777-8777-777777777777";
/** A user id with no org_member row anywhere. */
const OUTSIDER = "99999999-9999-4999-8999-999999999999";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const CREATOR = "55555555-5555-4555-8555-555555555555";

/** Calls recorded as { sql, values } for assertions. */
let calls: { sql: string; values: unknown[] }[] = [];
/**
 * org_member as ROWS. It used to be a flat `string[]` of user_ids, with no
 * status and no org column, so it could not tell a guard that checks org and
 * status from one that checks neither: dropping `AND status = 'active'` left
 * all nine tests green and a suspended member could be named on a chart
 * (audit mutation review).
 */
let members: { org_id: string; user_id: string; status: string }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM org_member")) {
      // Honour only what the statement actually asks for. org and status are
      // literals/binds in the SQL, so a guard that stops asking gets handed
      // the suspended or foreign row back and the refusal never happens —
      // which is the regression these tests exist to catch.
      const wantsActive = sql.includes("status = 'active'");
      const scopedToOrg = sql.includes("org_id =");
      // Found by shape, not by position, so the fake assumes no bind order:
      // the assignees arrive as the one array bind, the org as a string.
      const asked = (values.find((v) => Array.isArray(v)) as string[] | undefined) ?? [];
      const orgBind = values.find((v) => typeof v === "string") as string | undefined;
      return Promise.resolve(
        members
          .filter(
            (m) =>
              asked.includes(m.user_id) &&
              (!scopedToOrg || m.org_id === orgBind) &&
              (!wantsActive || m.status === "active"),
          )
          .map((m) => ({ user_id: m.user_id })),
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
  members = [
    { org_id: ORG, user_id: NP, status: "active" },
    { org_id: ORG, user_id: RN, status: "active" },
    { org_id: ORG, user_id: SUSPENDED, status: "suspended" },
    { org_id: OTHER_ORG, user_id: STRANGER, status: "active" },
  ];
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
    expect(membership?.values[0]).toBe(ORG);
    expect(membership?.values[1]).toEqual([NP, RN]);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO patient"));
    expect(insert?.sql).toContain("primary_np_user_id");
    expect(insert?.values).toContain(NP);
    expect(insert?.values).toContain(RN);
  });

  /**
   * Each of these is a name the chart would then show as responsible for this
   * patient: a suspended member no one can reach, or a stranger from another
   * tenant. app_user is global, so the FK behind these columns accepts any of
   * them — this guard is the only thing that does not.
   */
  for (const [label, userId] of [
    ["a user id with no membership anywhere", OUTSIDER],
    ["a suspended member", SUSPENDED],
    ["an active member of another org", STRANGER],
  ] as const) {
    it(`rejects ${label}, and writes no patient`, async () => {
      await expect(
        createPatient({
          orgId: ORG,
          createdByUserId: CREATOR,
          payload: { ...BASE_PAYLOAD, careTeam: { socialWorkerUserId: userId } },
        }),
      ).rejects.toThrow(/not an active member of this organization/);
      expect(calls.some((c) => c.sql.includes("INSERT INTO patient"))).toBe(false);
    });
  }

  it("asks org_member about THIS org, and only about active members", async () => {
    await createPatient({
      orgId: ORG,
      createdByUserId: CREATOR,
      payload: { ...BASE_PAYLOAD, careTeam: { primaryNpUserId: NP } },
    });
    const q = calls.find((c) => c.sql.includes("FROM org_member"))!;
    expect(q.sql).toContain("org_id =");
    expect(q.sql).toContain("status = 'active'");
  });

  it("CONTROL: the same stranger is assignable in the org they actually belong to", async () => {
    // Proves the refusal is about membership in the patient's org, not about
    // this user id being blacklisted.
    await expect(
      createPatient({
        orgId: OTHER_ORG,
        createdByUserId: CREATOR,
        payload: { ...BASE_PAYLOAD, careTeam: { socialWorkerUserId: STRANGER } },
      }),
    ).resolves.toEqual({ id: PATIENT });
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

  for (const [label, userId] of [
    ["a non-member", OUTSIDER],
    ["a suspended member", SUSPENDED],
    ["an active member of another org", STRANGER],
  ] as const) {
    it(`rejects reassignment to ${label}`, async () => {
      await expect(
        updatePatient({
          orgId: ORG,
          id: PATIENT,
          payload: { careTeam: { billingAgentUserId: userId } },
        }),
      ).rejects.toThrow(/not an active member of this organization/);
      expect(calls.some((c) => c.sql.includes("billing_agent_user_id ¶") || c.sql.includes("UPDATE patient"))).toBe(false);
    });
  }

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
