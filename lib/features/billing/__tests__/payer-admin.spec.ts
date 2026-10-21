/**
 * The payer roster write path (audit R17).
 *
 * The roster changed only through a seed and a deploy. These pin what an
 * operator's write goes through, in order: the roster lock, every state code
 * must exist, the name must be new, and the change and its audit row share one
 * transaction.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text; writeAudit is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() }, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: vi.fn(),
}));

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import {
  PayerInputSchema,
  UpdatePayerSchema,
  createPayer,
  updatePayer,
} from "../payer-admin.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYER = "c0000000-0000-4000-8000-000000000001";

let knownStates: string[];
let nameTaken: boolean;
let updated: { id: string; name: string }[];
let calls: { sql: string; values: unknown[] }[];

const viewRow = {
  id: PAYER, name: "Pallio Test MA Plan", parent_org: "Test", payer_type: "medicare_advantage_org",
  states_served: ["UT"], policy_index_url: null, external_payer_id: null, notes: null,
  prolonged_service_code: null, active: true,
  created_at: new Date("2026-09-15T00:00:00Z"), live_rules: {},
};

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM state WHERE")) {
      const asked = values[0] as string[];
      return Promise.resolve(asked.filter((s) => knownStates.includes(s)).map((state) => ({ state })));
    }
    if (sql.includes("FROM payer WHERE name")) return Promise.resolve(nameTaken ? [{ id: "other" }] : []);
    if (sql.includes("INSERT INTO payer")) return Promise.resolve([{ id: PAYER }]);
    if (sql.includes("UPDATE payer SET")) return Promise.resolve(updated);
    if (sql.includes("FROM payer p")) return Promise.resolve([viewRow]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  knownStates = ["UT", "OH", "NC", "SC"];
  nameTaken = false;
  updated = [{ id: PAYER, name: "Pallio Test MA Plan" }];
  vi.mocked(writeAudit).mockReset();
  vi.mocked(withOrgContext).mockReset();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const MA_PLAN = PayerInputSchema.parse({
  name: "Pallio Test MA Plan",
  parentOrg: "Test",
  payerType: "medicare_advantage_org",
  statesServed: ["UT"],
  notes: "Named by the client on the 9/14 call",
});
const inserted = () => calls.find((c) => c.sql.includes("INSERT INTO payer"));

describe("PayerInputSchema", () => {
  it("uppercases and de-duplicates the states", () => {
    expect(
      PayerInputSchema.parse({ name: "Some Plan", payerType: "commercial", statesServed: ["ut", "UT"] }).statesServed,
    ).toEqual(["UT"]);
  });

  it("refuses no states, a state that is not two letters, a type the CHECK refuses, and a non-URL", () => {
    const base = { name: "Some Plan", payerType: "commercial", statesServed: ["OH"] };
    expect(PayerInputSchema.safeParse({ ...base, statesServed: [] }).success).toBe(false);
    expect(PayerInputSchema.safeParse({ ...base, statesServed: ["OHIO"] }).success).toBe(false);
    expect(PayerInputSchema.safeParse({ ...base, payerType: "hmo" }).success).toBe(false);
    expect(PayerInputSchema.safeParse({ ...base, policyIndexUrl: "aetna policies" }).success).toBe(false);
    expect(PayerInputSchema.safeParse(base).success).toBe(true);
  });

  it("an edit must change something, may clear an optional field, and may withdraw the payer", () => {
    expect(UpdatePayerSchema.safeParse({}).success).toBe(false);
    expect(UpdatePayerSchema.safeParse({ policyIndexUrl: null }).success).toBe(true);
    expect(UpdatePayerSchema.parse({ active: false })).toEqual({ active: false });
  });
});

describe("createPayer", () => {
  it("refuses an unknown state code by name, and inserts nothing", async () => {
    const input = PayerInputSchema.parse({ name: "New Plan", payerType: "commercial", statesServed: ["UT", "ZZ"] });
    const err = await createPayer({ orgId: ORG, userId: USER, input }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("ZZ");
    expect(err.message).not.toContain("UT");
    expect(inserted()).toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("refuses a name already on the roster, and inserts nothing", async () => {
    nameTaken = true;
    await expect(createPayer({ orgId: ORG, userId: USER, input: MA_PLAN })).rejects.toBeInstanceOf(ValidationError);
    expect(inserted()).toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("checks under the roster lock, states before the name, before the insert", async () => {
    await createPayer({ orgId: ORG, userId: USER, input: MA_PLAN });
    const at = (needle: string) => calls.findIndex((c) => c.sql.includes(needle));
    expect(at("pg_advisory_xact_lock")).toBe(0);
    expect(at("FROM state WHERE")).toBeLessThan(at("FROM payer WHERE name"));
    expect(at("FROM payer WHERE name")).toBeLessThan(at("INSERT INTO payer"));
  });

  it("inserts the type and states, and audits the change in the same org transaction", async () => {
    const view = await createPayer({ orgId: ORG, userId: USER, input: MA_PLAN });
    expect(inserted()!.values).toContain("medicare_advantage_org");
    expect(inserted()!.values).toContainEqual(["UT"]);
    expect(withOrgContext).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry).toMatchObject({
      orgId: ORG, userId: USER, action: "payer_roster_change", targetType: "payer", targetId: PAYER,
    });
    expect(entry.payload).toMatchObject({ op: "create", name: "Pallio Test MA Plan", statesServed: ["UT"] });
    expect(view).toMatchObject({ id: PAYER, payerType: "medicare_advantage_org", statesServed: ["UT"], liveRules: {} });
  });

  it("keeps free text out of the audit payload: field names only", async () => {
    await createPayer({ orgId: ORG, userId: USER, input: MA_PLAN });
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(JSON.stringify(entry.payload)).not.toContain("9/14");
    expect(entry.payload!.fields).toEqual(["name", "notes", "parent_org", "payer_type", "states_served"]);
  });
});

describe("updatePayer", () => {
  it("withdraws a payer by sending active = false, and audits it", async () => {
    await updatePayer({ orgId: ORG, userId: USER, id: PAYER, patch: { active: false } });
    const update = calls.find((c) => c.sql.includes("UPDATE payer SET"))!;
    expect(update.sql).toContain("active");
    expect(update.values).toContain(false);
    expect(update.values).toContain(PAYER);
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.payload).toEqual({ op: "update", name: "Pallio Test MA Plan", fields: ["active"], active: false });
  });

  it("checks new states and a new name, excluding the payer itself", async () => {
    await updatePayer({
      orgId: ORG, userId: USER, id: PAYER, patch: { name: "Renamed Plan", statesServed: ["UT", "NC"] },
    });
    const nameCheck = calls.find((c) => c.sql.includes("FROM payer WHERE name"))!;
    expect(nameCheck.values).toEqual(["Renamed Plan", PAYER, PAYER]);
    expect(calls.some((c) => c.sql.includes("FROM state WHERE"))).toBe(true);
  });

  it("does not look up states or names it was not asked to change", async () => {
    await updatePayer({ orgId: ORG, userId: USER, id: PAYER, patch: { active: true } });
    expect(calls.some((c) => c.sql.includes("FROM state WHERE"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("FROM payer WHERE name"))).toBe(false);
  });

  it("throws NotFoundError when no row was updated, and writes no audit row", async () => {
    updated = [];
    await expect(
      updatePayer({ orgId: ORG, userId: USER, id: PAYER, patch: { active: false } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

/**
 * The prolonged-service code a payer takes (0108). Absent or null leaves the
 * payer type to decide; G0318 or 99417 names the payer's own choice. It is a
 * closed set, so the audit row may carry the value as well as the column.
 */
describe("the payer's prolonged-service code (0108)", () => {
  const update = () => calls.find((c) => c.sql.includes("UPDATE payer SET"))!;
  /** The keep-flag bound for prolonged_service_code, and the value after it. */
  const prolongedBinds = () => {
    const u = update();
    const at = u.sql.slice(0, u.sql.indexOf("prolonged_service_code = CASE WHEN ¶")).split("¶").length - 1;
    return { keep: u.values[at], value: u.values[at + 1] };
  };

  it("takes G0318, 99417 or null, and nothing else", () => {
    const base = { name: "Some Plan", payerType: "medicaid_mco", statesServed: ["OH"] };
    expect(PayerInputSchema.parse({ ...base, prolongedServiceCode: "G0318" }).prolongedServiceCode).toBe("G0318");
    expect(PayerInputSchema.safeParse({ ...base, prolongedServiceCode: "99417" }).success).toBe(true);
    expect(PayerInputSchema.safeParse({ ...base, prolongedServiceCode: null }).success).toBe(true);
    expect(PayerInputSchema.safeParse({ ...base, prolongedServiceCode: "99999" }).success).toBe(false);
    expect(UpdatePayerSchema.parse({ prolongedServiceCode: null })).toEqual({ prolongedServiceCode: null });
  });

  it("is stored on a new payer and named in its audit row", async () => {
    const input = PayerInputSchema.parse({
      name: "Ohio MCO", payerType: "medicaid_mco", statesServed: ["OH"], prolongedServiceCode: "G0318",
    });
    await createPayer({ orgId: ORG, userId: USER, input });
    expect(inserted()!.sql).toContain("prolonged_service_code");
    expect(inserted()!.values).toContain("G0318");
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.payload).toMatchObject({ prolongedServiceCode: "G0318" });
    expect(entry.payload!.fields).toContain("prolonged_service_code");
  });

  it("CONTROL: a new payer that names none is stored with none, and its audit row says nothing of it", async () => {
    await createPayer({ orgId: ORG, userId: USER, input: MA_PLAN });
    expect(inserted()!.values.at(-1)).toBeNull();
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.payload).not.toHaveProperty("prolongedServiceCode");
  });

  it("is set on an edit, and the audit row names it with its value", async () => {
    await updatePayer({ orgId: ORG, userId: USER, id: PAYER, patch: { prolongedServiceCode: "G0318" } });
    expect(prolongedBinds()).toEqual({ keep: false, value: "G0318" });
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.payload).toEqual({
      op: "update", name: "Pallio Test MA Plan", fields: ["prolonged_service_code"], prolongedServiceCode: "G0318",
    });
  });

  it("is cleared back to the payer type's default with null", async () => {
    await updatePayer({ orgId: ORG, userId: USER, id: PAYER, patch: { prolongedServiceCode: null } });
    expect(prolongedBinds()).toEqual({ keep: false, value: null });
  });

  it("CONTROL: an edit that does not mention it leaves it as it is", async () => {
    await updatePayer({ orgId: ORG, userId: USER, id: PAYER, patch: { active: true } });
    expect(prolongedBinds().keep).toBe(true);
  });

  it("comes back on the payer view", async () => {
    const view = await updatePayer({ orgId: ORG, userId: USER, id: PAYER, patch: { active: true } });
    expect(view.prolongedServiceCode).toBeNull();
  });
});
