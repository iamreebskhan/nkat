/**
 * The intake pipeline (Level-1 doc:22-28, 0111): the rules the service keeps
 * whatever screen calls it. lib/db is mocked with a fake tx that records every
 * statement and answers the few reads each test configures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/hipaa/pgp", () => ({ applyPhiKeyIfConfigured: vi.fn(async () => false) }));
vi.mock("@/lib/features/org/org-time-zone", () => ({ readOrgTimeZone: vi.fn(async () => "America/New_York") }));
vi.mock("@/lib/features/org/org-date", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/org/org-date")>()),
  orgToday: vi.fn(() => "2026-10-28"),
}));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import {
  addInsuranceVerification,
  admitReferralInTx,
  changeReferralStage,
  createReferral,
  setReferralRequirements,
} from "../referral.service";
import { stageMovesFrom } from "../referral.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFERRAL = "f0000000-0000-4000-8000-000000000001";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const CODE_21A = "c0000000-0000-4000-8000-0000000000a1";
const R1 = "d0000000-0000-4000-8000-000000000001";
const R2 = "d0000000-0000-4000-8000-000000000002";
const CHECK = "e0000000-0000-4000-8000-000000000001";

let calls: { sql: string; values: unknown[] }[];
/** What the referral row reads as, for the statements that read it. */
let referral: { stage: string; received_on: string; requirements: unknown[]; patient_id: string | null } | null;
/** The NTUC codes the fake org holds, active ones only. */
let ntucCodes: Record<string, string>;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (/SELECT (stage|stage, )/.test(sql) && sql.includes("FROM referral")) {
      return Promise.resolve(referral ? [referral] : []);
    }
    if (sql.includes("SELECT count(*)::bigint AS n FROM org_reason_code")) return Promise.resolve([{ n: BigInt(23) }]);
    if (sql.includes("SELECT code FROM org_reason_code")) {
      const id = values.find((v) => typeof v === "string" && ntucCodes[v as string]) as string | undefined;
      return Promise.resolve(id ? [{ code: ntucCodes[id] }] : []);
    }
    if (sql.includes("INSERT INTO referral (")) return Promise.resolve([{ id: REFERRAL }]);
    if (sql.includes("INSERT INTO insurance_verification")) return Promise.resolve([{ id: CHECK }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  referral = { stage: "pre_admission", received_on: "2026-10-20", requirements: [], patient_id: null };
  ntucCodes = { [CODE_21A]: "21a" };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);
const wrote = (fragment: string) => calls.some((c) => c.sql.includes(fragment));

describe("createReferral", () => {
  const base = { receivedOn: "2026-10-27", firstName: "Ruth", lastName: "Alvarez" };

  it("takes a referral received today or before, and audits no name", async () => {
    await createReferral({ orgId: ORG, userId: USER, payload: { ...base, sourceName: "TH Oncology" } });
    expect(wrote("INSERT INTO referral (")).toBe(true);
    const entry = audited()[0]!;
    expect(entry).toMatchObject({ action: "referral_create", targetType: "referral", targetId: REFERRAL });
    expect(JSON.stringify(entry.payload)).not.toMatch(/Ruth|Alvarez|Oncology/);
  });

  it("CONTROL: refuses a referral received after the practice's today", async () => {
    await expect(
      createReferral({ orgId: ORG, userId: USER, payload: { ...base, receivedOn: "2026-10-29" } }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(wrote("INSERT INTO referral (")).toBe(false);
  });
});

describe("stage moves", () => {
  it("offers the pipeline's dispositions from an open referral, and none from an admitted one", () => {
    expect(stageMovesFrom("pre_admission")).toEqual(["pending_long_term", "ntuc", "transitioned"]);
    expect(stageMovesFrom("ntuc")).toEqual(["pre_admission"]);
    expect(stageMovesFrom("admitted")).toEqual([]);
  });

  it("closes a referral as NTUC with the practice's code and day, and audits the code number", async () => {
    await changeReferralStage({
      orgId: ORG, userId: USER, id: REFERRAL,
      change: { to: "ntuc", reasonCodeId: CODE_21A, on: "2026-10-27" },
    });
    const update = calls.find((c) => c.sql.includes("UPDATE referral SET"))!;
    expect(update.values).toEqual(expect.arrayContaining(["ntuc", CODE_21A, "2026-10-27"]));
    expect(audited()[0]).toMatchObject({
      action: "referral_stage",
      payload: { from: "pre_admission", to: "ntuc", reasonCode: "21a" },
    });
  });

  it("CONTROL: refuses another org's or a retired code, and a day outside the referral", async () => {
    const other = "c0000000-0000-4000-8000-0000000000ff";
    for (const change of [
      { to: "ntuc" as const, reasonCodeId: other, on: "2026-10-27" },
      { to: "ntuc" as const, reasonCodeId: CODE_21A, on: "2026-10-29" },
      { to: "ntuc" as const, reasonCodeId: CODE_21A, on: "2026-10-19" },
    ]) {
      await expect(changeReferralStage({ orgId: ORG, userId: USER, id: REFERRAL, change })).rejects.toMatchObject({
        name: "ValidationError",
      });
    }
    expect(wrote("UPDATE referral SET")).toBe(false);
  });

  it("CONTROL: an admitted referral has a chart now and moves nowhere", async () => {
    referral = { ...referral!, stage: "admitted" };
    await expect(
      changeReferralStage({ orgId: ORG, userId: USER, id: REFERRAL, change: { to: "pre_admission" } }),
    ).rejects.toThrow(/chart/);
  });

  it("reopening clears the NTUC code and day, so the reports stop counting it", async () => {
    referral = { ...referral!, stage: "ntuc" };
    await changeReferralStage({ orgId: ORG, userId: USER, id: REFERRAL, change: { to: "pre_admission" } });
    const update = calls.find((c) => c.sql.includes("UPDATE referral SET"))!;
    const at = (col: string) => {
      const parts = update.sql.split("¶");
      return update.values[parts.findIndex((p) => p.includes(`${col} =`))];
    };
    expect(at("ntuc_reason_code_id")).toBeNull();
    expect(at("ntuc_on")).toBeNull();
  });
});

describe("the pending-requirements checklist", () => {
  it("stamps an item ticked now, keeps an earlier stamp, and clears an unticked one", async () => {
    referral = {
      ...referral!,
      requirements: [
        { id: R1, label: "Signed order", doneAt: "2026-10-21T15:00:00.000Z", doneBy: "someone" },
        { id: R2, label: "H&P from PCP", doneAt: "2026-10-22T15:00:00.000Z", doneBy: "someone" },
      ],
    };
    const next = await setReferralRequirements({
      orgId: ORG, userId: USER, id: REFERRAL,
      items: [
        { id: R1, label: "Signed order", done: true },
        { id: R2, label: "H&P from PCP", done: false },
        { id: "d0000000-0000-4000-8000-000000000003", label: "Insurance auth", done: true },
      ],
    });
    expect(next[0]).toMatchObject({ doneAt: "2026-10-21T15:00:00.000Z", doneBy: "someone" });
    expect(next[1]).toMatchObject({ doneAt: null, doneBy: null });
    expect(next[2]!.doneBy).toBe(USER);
    expect(audited()[0]).toMatchObject({ action: "referral_requirements", payload: { done: 2, total: 3 } });
  });

  it("CONTROL: a closed referral's checklist is not changed", async () => {
    referral = { ...referral!, stage: "transitioned" };
    await expect(
      setReferralRequirements({ orgId: ORG, userId: USER, id: REFERRAL, items: [] }),
    ).rejects.toMatchObject({ name: "ValidationError" });
  });
});

describe("coverage checks", () => {
  const check = { method: "portal" as const, result: "active" as const };
  const insert = () => calls.find((c) => c.sql.includes("INSERT INTO insurance_verification"));
  // INSERT … VALUES (org, referral, patient, …)
  const patientOf = () => insert()!.values[2];

  it("puts a check made after admission on the chart as well as the referral", async () => {
    referral = { ...referral!, stage: "admitted", patient_id: PATIENT };
    await addInsuranceVerification({ orgId: ORG, userId: USER, subject: { referralId: REFERRAL }, payload: check });
    expect(insert()!.values[1]).toBe(REFERRAL);
    expect(patientOf()).toBe(PATIENT);
    expect(audited()[0]).toMatchObject({ targetId: REFERRAL, payload: { subject: "referral", patientId: PATIENT } });
  });

  it("CONTROL: an open referral's check names no patient yet, and a closed referral takes none", async () => {
    await addInsuranceVerification({ orgId: ORG, userId: USER, subject: { referralId: REFERRAL }, payload: check });
    expect(patientOf()).toBeNull();
    for (const stage of ["ntuc", "transitioned"]) {
      referral = { ...referral!, stage };
      calls = [];
      await expect(
        addInsuranceVerification({ orgId: ORG, userId: USER, subject: { referralId: REFERRAL }, payload: check }),
      ).rejects.toThrow(/Reopen/);
      expect(insert()).toBeUndefined();
    }
  });
});

describe("admission", () => {
  it("marks the referral admitted on the practice's today, names the patient, and moves its coverage checks over", async () => {
    await admitReferralInTx(fakeTx() as never, { orgId: ORG, referralId: REFERRAL, patientId: PATIENT, userId: USER });
    const update = calls.find((c) => c.sql.includes("stage = 'admitted'"))!;
    expect(update.values).toEqual(expect.arrayContaining(["2026-10-28", PATIENT, REFERRAL, ORG]));
    expect(wrote("UPDATE insurance_verification SET patient_id")).toBe(true);
    expect(wrote("UPDATE patient_document SET patient_id")).toBe(true);
    expect(audited()[0]).toMatchObject({ payload: { from: "pre_admission", to: "admitted", patientId: PATIENT } });
  });

  it("CONTROL: a referral already admitted or closed refuses, so the intake rolls back", async () => {
    for (const r of [
      { stage: "admitted", patient_id: PATIENT },
      { stage: "ntuc", patient_id: null },
    ]) {
      referral = { ...referral!, ...r };
      calls = [];
      await expect(
        admitReferralInTx(fakeTx() as never, { orgId: ORG, referralId: REFERRAL, patientId: PATIENT, userId: USER }),
      ).rejects.toMatchObject({ name: "ValidationError" });
      expect(wrote("stage = 'admitted'")).toBe(false);
    }
  });
});
