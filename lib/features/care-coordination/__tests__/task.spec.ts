/**
 * Tasks to the interdisciplinary team (0116; doc:40, :54): who may be given
 * one, who may close it, and what the bell and the audit say. lib/db is mocked
 * with a fake tx; the practice's today is 2026-10-28.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/org/org-time-zone", () => ({ readOrgTimeZone: vi.fn(async () => "America/New_York") }));
vi.mock("@/lib/features/org/org-date", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/org/org-date")>()),
  orgToday: vi.fn(() => "2026-10-28"),
}));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { UpdateTaskSchema } from "../care-coordination.types";
import { createTask, updateTask } from "../task.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const OTHER_PATIENT = "45444444-4444-4444-8444-444444444444";
const VISIT = "55555555-5555-4555-8555-555555555555";
const TASK = "c1000000-0000-4000-8000-000000000001";

let calls: { sql: string; values: unknown[] }[];
let members: string[];
let visitPatient: string | null;
let task: { patient_id: string | null; status: string; assignee_user_id: string | null; discipline: string } | null;
let chaplain: string | null;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM org_member")) return Promise.resolve(members.includes(values[1] as string) ? [{ ok: 1 }] : []);
    if (sql.includes("SELECT patient_id FROM visit")) return Promise.resolve(visitPatient ? [{ patient_id: visitPatient }] : []);
    if (sql.includes("AS chaplain")) return Promise.resolve([{ id: PATIENT, chaplain }]);
    if (sql.includes("FROM care_task") && sql.includes("FOR UPDATE")) return Promise.resolve(task ? [task] : []);
    if (sql.includes("INSERT INTO care_task")) return Promise.resolve([{ id: TASK }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  members = [ME, SW];
  visitPatient = PATIENT;
  chaplain = null;
  task = { patient_id: PATIENT, status: "open", assignee_user_id: SW, discipline: "social_work" };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const find = (fragment: string) => calls.filter((c) => c.sql.includes(fragment));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);
const give = (payload: Partial<Parameters<typeof createTask>[0]["payload"]>) =>
  createTask({ orgId: ORG, userId: ME, payload: { title: "Call the daughter", discipline: "social_work", patientId: PATIENT, ...payload } });

describe("a chaplaincy task (0127)", () => {
  const CHAPLAIN = "66666666-6666-4666-8666-666666666666";

  it("goes to the patient's chaplain when nobody is named, and rings their bell", async () => {
    chaplain = CHAPLAIN;
    await give({ discipline: "chaplaincy" });
    expect(find("INSERT INTO care_task")[0]!.values).toContain(CHAPLAIN);
    expect(find("INSERT INTO notification")[0]!.values[1]).toBe(CHAPLAIN);
    expect(audited()[0]).toMatchObject({ payload: { op: "create", discipline: "chaplaincy", assigned: true } });
  });

  it("goes to whoever is named instead", async () => {
    chaplain = CHAPLAIN;
    await give({ discipline: "chaplaincy", assigneeUserId: SW });
    expect(find("INSERT INTO care_task")[0]!.values).toContain(SW);
    expect(find("INSERT INTO care_task")[0]!.values).not.toContain(CHAPLAIN);
  });

  it("CONTROL: with no chaplain it waits for the discipline, and another discipline never goes to the chaplain", async () => {
    await give({ discipline: "chaplaincy" });
    expect(audited()[0]).toMatchObject({ payload: { assigned: false } });
    vi.mocked(writeAudit).mockClear();
    chaplain = CHAPLAIN;
    await give({ discipline: "social_work" });
    expect(find("INSERT INTO care_task")[1]!.values).not.toContain(CHAPLAIN);
    expect(audited()[0]).toMatchObject({ payload: { assigned: false } });
  });
});

describe("giving a task", () => {
  it("to a member, who is told who gave it and about whom, never its words", async () => {
    await give({ assigneeUserId: SW, details: "About respite care" });
    expect(find("INSERT INTO care_task")[0]!.values).toEqual(expect.arrayContaining(["Call the daughter", "social_work", SW]));
    const bell = find("INSERT INTO notification")[0]!;
    expect(bell.values[1]).toBe(SW);
    const payload = JSON.parse(bell.values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(payload).toEqual({ taskId: TASK, patientId: PATIENT, byUserId: ME });
    expect(audited()[0]).toMatchObject({ action: "care_task", targetType: "patient", payload: { op: "create", discipline: "social_work", assigned: true } });
    expect(JSON.stringify(audited())).not.toMatch(/daughter|respite/);
  });

  it("a task given to yourself rings no bell; one for nobody waits for the discipline", async () => {
    await give({ assigneeUserId: ME });
    await give({});
    expect(find("INSERT INTO notification")).toHaveLength(0);
  });

  it("from a visit, it is that visit's patient's", async () => {
    await give({ patientId: undefined, visitId: VISIT });
    expect(find("INSERT INTO care_task")[0]!.values).toEqual(expect.arrayContaining([PATIENT, VISIT]));
  });

  it("an administrative task is about no patient, and is audited against itself", async () => {
    await give({ patientId: undefined, discipline: "admin" });
    expect(audited()[0]).toMatchObject({ targetType: "care_task", targetId: TASK });
  });

  it("CONTROL: refuses someone not an active member, a due day passed, and another patient's visit", async () => {
    await expect(give({ assigneeUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).rejects.toThrow(/not an active member/);
    await expect(give({ dueOn: "2026-10-27" })).rejects.toThrow(/due day has passed/);
    visitPatient = OTHER_PATIENT;
    await expect(give({ visitId: VISIT })).rejects.toThrow(/not this patient's/);
    expect(find("INSERT INTO care_task")).toHaveLength(0);
  });
});

describe("closing and changing a task", () => {
  const update = (payload: Parameters<typeof updateTask>[0]["payload"], who = SW, canEditAny = false) =>
    updateTask({ orgId: ORG, userId: who, taskId: TASK, payload, canEditAny });

  it("the person it is assigned to marks it done, with what was done", async () => {
    await update({ done: { note: "Spoke with her" } });
    expect(find("UPDATE care_task SET status")[0]!.values).toEqual(expect.arrayContaining(["done", SW, "Spoke with her"]));
    expect(audited()[0]).toMatchObject({ payload: { op: "done", discipline: "social_work" } });
    expect(JSON.stringify(audited())).not.toContain("Spoke with her");
  });

  it("CONTROL: someone else without the permission to edit charts cannot close it, nor change it", async () => {
    await expect(update({ done: {} }, ME)).rejects.toThrow(/Only the person this task is assigned to/);
    await expect(update({ title: "Renamed" }, SW)).rejects.toThrow(/permission to edit charts/);
    expect(find("UPDATE care_task")).toHaveLength(0);
  });

  it("reassigning tells the new person; the audit names the field, not the person", async () => {
    // Taking it yourself rings no bell.
    await update({ assigneeUserId: ME }, ME, true);
    expect(find("INSERT INTO notification")).toHaveLength(0);
    // Nor does naming the person who already has it.
    await update({ assigneeUserId: SW }, ME, true);
    expect(find("INSERT INTO notification")).toHaveLength(0);
    task = { ...task!, assignee_user_id: null };
    await update({ assigneeUserId: SW }, ME, true);
    expect(find("INSERT INTO notification")).toHaveLength(1);
    expect(find("INSERT INTO notification")[0]!.values[1]).toBe(SW);
    expect(audited().at(-1)).toMatchObject({ payload: { op: "edit", fields: ["assigneeUserId"] } });
    expect(JSON.stringify(audited())).not.toContain(SW);
  });

  it("CONTROL: a closed task takes nothing more; cancelling needs a reason", async () => {
    task = { ...task!, status: "done" };
    await expect(update({ cancel: { reason: "x" } })).rejects.toThrow(/already done/);
    expect(UpdateTaskSchema.safeParse({ cancel: { reason: " " } }).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({}).success).toBe(false);
  });
});
