/**
 * The practice's own NCCI edits (0122): what a load may hold, how one takes
 * over from the last, and what the audit trail says. lib/db is mocked with a
 * fake tx answering by statement. Reading CMS's files is ncci-files.spec.ts;
 * the SQL itself was run against Postgres (browser test, 31 Oct 2026).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  calls: [] as { sql: string; values: unknown[] }[],
  load: null as null | { kind: string; status: string; rows_kept: number; in_force_from?: string | null },
  inserted: 0,
  replaced: [] as { id: string }[],
  current: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db", () => ({
  withOrgContext: async (_o: string, fn: (tx: unknown) => unknown) => {
    const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("¶");
      h.calls.push({ sql, values });
      if (sql.includes("SELECT k.c AS code")) return Promise.resolve([{ code: "99350" }, { code: "G0318" }, { code: "Q9999" }]);
      if (sql.includes("FOR UPDATE")) return Promise.resolve(h.load ? [h.load] : []);
      if (sql.includes("SET status = 'replaced'") && sql.includes("RETURNING id")) return Promise.resolve(h.replaced);
      if (sql.includes("INSERT INTO org_ncci_load")) return Promise.resolve([{ id: "new-load" }]);
      if (sql.includes("INSERT INTO org_ncci_")) return Promise.resolve(h.inserted);
      if (sql.includes("to_char(in_force_from, 'YYYY-MM-DD') AS in_force_from, files")) {
        return Promise.resolve([{ in_force_from: h.load?.in_force_from ?? null, files: ["a.zip", "b.zip"] }]);
      }
      if (sql.includes("FROM org_ncci_load l")) return Promise.resolve(h.current);
      if (sql.includes("timezone")) return Promise.resolve([{ timezone: "America/New_York" }]);
      return Promise.resolve(sql.trimStart().startsWith("SELECT") ? [] : 1);
    };
    return fn({ $queryRaw: run, $executeRaw: run });
  },
}));
vi.mock("@/lib/features/audit/audit-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: h.audit,
}));

import { NotFoundError, ValidationError } from "@/lib/api";

import {
  NCCI_BATCH_MAX,
  NCCI_ROWS_MAX,
  NcciRowsSchema,
  StartNcciLoadSchema,
  addNcciRows,
  commitNcciLoad,
  getNcciStatus,
  removeNcciLoad,
  startNcciLoad,
} from "../ncci-load.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOAD = "5b000000-0000-4000-8000-000000000001";

const pair = { column1: "99350", column2: "G0318", modifierIndicator: 1 as const, effective: "2024-01-01", deletion: null, rationale: null };
const mue = { code: "G0318", unitsMax: 2, adjudication: 2 as const, rationale: null };
const ran = (s: string) => h.calls.filter((c) => c.sql.includes(s));

beforeEach(() => {
  h.audit.mockReset();
  h.calls = [];
  h.load = null;
  h.inserted = 0;
  h.replaced = [];
  h.current = [];
});

describe("what a load may hold", () => {
  const base = { kind: "ptp" as const, files: ["ptp-f1.zip"], licenceAccepted: true };

  it("needs the practice's own acceptance of CMS's licence, said in a plain sentence", () => {
    const r = StartNcciLoadSchema.safeParse({ ...base, licenceAccepted: false });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path).toEqual([]);
      expect(r.error.issues[0]!.message).toMatch(/downloaded from CMS by your practice/);
    }
  });

  it("MUE values need the date they apply from; PTP pairs carry their own", () => {
    expect(StartNcciLoadSchema.safeParse({ ...base, kind: "mue" }).success).toBe(false);
    expect(StartNcciLoadSchema.safeParse({ ...base, kind: "mue", inForceFrom: "2026-10-01" }).success).toBe(true);
    expect(StartNcciLoadSchema.safeParse({ ...base, inForceFrom: "2026-10-01" }).success).toBe(false);
    expect(StartNcciLoadSchema.safeParse({ ...base, kind: "mue", inForceFrom: "2026-13-01" }).success).toBe(false);
    // CONTROL: the plain PTP load is taken.
    expect(StartNcciLoadSchema.safeParse(base).success).toBe(true);
  });

  it("refuses rows that are not codes, indicator 9, a deletion not after the start, and an oversize batch", () => {
    expect(NcciRowsSchema.safeParse({ ptp: [{ ...pair, column1: "9935" }] }).success).toBe(false);
    expect(NcciRowsSchema.safeParse({ ptp: [{ ...pair, modifierIndicator: 9 }] }).success).toBe(false);
    expect(NcciRowsSchema.safeParse({ ptp: [{ ...pair, deletion: "2024-01-01" }] }).success).toBe(false);
    expect(NcciRowsSchema.safeParse({ mue: [{ ...mue, unitsMax: -1 }] }).success).toBe(false);
    expect(NcciRowsSchema.safeParse({ mue: Array(NCCI_BATCH_MAX + 1).fill(mue) }).success).toBe(false);
    // CONTROL: a good row of each kind, and CMS's MUE of 0.
    expect(NcciRowsSchema.safeParse({ ptp: [pair], mue: [{ ...mue, unitsMax: 0 }] }).success).toBe(true);
  });
});

describe("starting a load", () => {
  it("drops a load left half-sent, and notes which codes PTP pairs were kept for", async () => {
    const r = await startNcciLoad({ orgId: ORG, userId: USER, payload: { kind: "ptp", files: ["a.zip"], licenceAccepted: true } });
    expect(r).toEqual({ id: "new-load", codes: ["99350", "G0318", "Q9999"] });
    const order = h.calls.map((c) => c.sql);
    expect(order[0]).toContain("DELETE FROM org_ncci_load");
    expect(order[0]).toContain("status = 'staging'");
    expect(ran("INSERT INTO org_ncci_load")[0]!.values).toContainEqual(["99350", "G0318", "Q9999"]);
  });

  it("CONTROL: an MUE load keeps no code list", async () => {
    const r = await startNcciLoad({ orgId: ORG, userId: USER, payload: { kind: "mue", files: ["a.zip"], inForceFrom: "2026-10-01", licenceAccepted: true } });
    expect(r.codes).toEqual([]);
    expect(ran("SELECT k.c AS code")).toHaveLength(0);
  });
});

describe("sending rows", () => {
  it("adds them and counts only what was new", async () => {
    h.load = { kind: "ptp", status: "staging", rows_kept: 10 };
    h.inserted = 1;
    await expect(addNcciRows({ orgId: ORG, loadId: LOAD, payload: { ptp: [pair, pair] } })).resolves.toEqual({ added: 1, total: 11 });
    expect(ran("rows_kept = rows_kept +")[0]!.values[0]).toBe(1);
  });

  it("refuses a load that has gone, is finished, is the other kind, or would pass the cap", async () => {
    await expect(addNcciRows({ orgId: ORG, loadId: LOAD, payload: { ptp: [pair] } })).rejects.toBeInstanceOf(NotFoundError);
    h.load = { kind: "ptp", status: "current", rows_kept: 3 };
    await expect(addNcciRows({ orgId: ORG, loadId: LOAD, payload: { ptp: [pair] } })).rejects.toThrow(/already finished/);
    h.load = { kind: "ptp", status: "staging", rows_kept: 0 };
    await expect(addNcciRows({ orgId: ORG, loadId: LOAD, payload: { mue: [mue] } })).rejects.toThrow(/the other kind/);
    h.load = { kind: "mue", status: "staging", rows_kept: NCCI_ROWS_MAX.mue };
    await expect(addNcciRows({ orgId: ORG, loadId: LOAD, payload: { mue: [mue] } })).rejects.toThrow(/not the files Pallio expects/);
    expect(ran("INSERT INTO org_ncci_")).toHaveLength(0);
  });
});

describe("putting a load in use", () => {
  const view = { id: LOAD, kind: "ptp", status: "current", in_force_from: null, files: ["a.zip", "b.zip"], rows_read: 2_700_000, rows_kept: 3, codes_covered: ["99350"], loaded_by_name: "Helen", loaded_at: "2026-10-31T00:00:00Z" };

  it("refuses a load with nothing in it, and changes nothing", async () => {
    h.load = { kind: "ptp", status: "staging", rows_kept: 0 };
    await expect(commitNcciLoad({ orgId: ORG, userId: USER, loadId: LOAD, rowsRead: 500 })).rejects.toBeInstanceOf(ValidationError);
    expect(ran("SET status = 'current'")).toHaveLength(0);
  });

  it("takes over from the PTP pairs in use: their rows go, the record stays", async () => {
    h.load = { kind: "ptp", status: "staging", rows_kept: 3 };
    h.replaced = [{ id: "old-load" }];
    h.current = [view];
    await commitNcciLoad({ orgId: ORG, userId: USER, loadId: LOAD, rowsRead: 2_700_000 });
    expect(ran("DELETE FROM org_ncci_ptp")[0]!.values[0]).toEqual(["old-load"]);
    expect(ran("DELETE FROM org_ncci_load")).toHaveLength(0);
    expect(ran("SET status = 'current'")).toHaveLength(1);
  });

  it("an MUE load replaces only the load of its own date: earlier quarters stay in use", async () => {
    h.load = { kind: "mue", status: "staging", rows_kept: 3, in_force_from: "2026-10-01" };
    h.current = [{ ...view, kind: "mue" }];
    await commitNcciLoad({ orgId: ORG, userId: USER, loadId: LOAD, rowsRead: 3 });
    const replace = ran("SET status = 'replaced'")[0]!;
    expect(replace.sql).toContain("in_force_from =");
    expect(replace.values).toContain("2026-10-01");
    expect(ran("DELETE FROM org_ncci_mue")).toHaveLength(0);
  });

  it("logs counts and dates, never a row", async () => {
    h.load = { kind: "ptp", status: "staging", rows_kept: 3 };
    h.current = [view];
    await commitNcciLoad({ orgId: ORG, userId: USER, loadId: LOAD, rowsRead: 2_700_000 });
    const entry = h.audit.mock.calls[0]![1];
    expect(entry).toMatchObject({ action: "ncci_load", targetType: "ncci_load", targetId: LOAD });
    expect(entry.payload).toEqual({ kind: "ptp", change: "loaded", rowsRead: 2_700_000, rowsKept: 3, files: 2, inForceFrom: null, replaced: 0 });
  });
});

describe("stopping", () => {
  it("drops a staging load outright, with nothing to audit", async () => {
    h.load = { kind: "ptp", status: "staging", rows_kept: 3 };
    await removeNcciLoad({ orgId: ORG, userId: USER, loadId: LOAD });
    expect(ran("DELETE FROM org_ncci_load")).toHaveLength(1);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("takes a load out of use: its rows go, the record stays, and the log says so", async () => {
    h.load = { kind: "mue", status: "current", rows_kept: 3, in_force_from: "2026-10-01" };
    await removeNcciLoad({ orgId: ORG, userId: USER, loadId: LOAD });
    expect(ran("DELETE FROM org_ncci_mue")).toHaveLength(1);
    expect(ran("DELETE FROM org_ncci_load")).toHaveLength(0);
    expect(h.audit.mock.calls[0]![1].payload).toEqual({ kind: "mue", change: "removed", rowsKept: 3, inForceFrom: "2026-10-01" });
  });

  it("CONTROL: a load already replaced is not in use", async () => {
    h.load = { kind: "ptp", status: "replaced", rows_kept: 3 };
    await expect(removeNcciLoad({ orgId: ORG, userId: USER, loadId: LOAD })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("what is in use", () => {
  const ptp = { id: LOAD, kind: "ptp", status: "current", in_force_from: null, files: ["a.zip"], rows_read: 9, rows_kept: 3, codes_covered: ["99350", "G0318"], loaded_by_name: "Helen", loaded_at: "2026-10-31T00:00:00Z" };

  it("names the codes Pallio knows now that the pairs in use were not kept for", async () => {
    h.current = [ptp];
    const s = await getNcciStatus({ orgId: ORG });
    expect(s.ptp?.codesCovered).toBe(2);
    expect(s.uncovered).toEqual(["Q9999"]);
  });

  it("CONTROL: with no pairs loaded nothing is called uncovered", async () => {
    const s = await getNcciStatus({ orgId: ORG });
    expect(s.ptp).toBeNull();
    expect(s.uncovered).toEqual([]);
    expect(s.codes).toHaveLength(3);
  });
});
