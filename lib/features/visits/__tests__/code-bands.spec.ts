/**
 * The CPT time ladders, read from `code.typical_minutes`.
 *
 * The bug this file guards against: the suggester used to carry its own copy
 * of the ladder, and that copy had drifted from the code descriptors, the AI
 * parser prompt and the gold-standard eval. Seven of eight bands fired early,
 * every one of them toward the higher-paying code. Bands are now derived from
 * the code table, so what is tested here is that the derivation is faithful
 * and that a gap in the data produces no band rather than a wrong one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn() },
  withOrgContext: vi.fn(),
}));

import { prisma } from "@/lib/db";

import {
  buildBands,
  ESTABLISHED_PATIENT_HOME_CODES,
  NEW_PATIENT_HOME_CODES,
} from "../cpt-suggester";
import { getVisitCodeBands } from "../code-bands.service";

/** The ladder db/seed/0007_palliative_codes.sql states. */
const SEEDED = [
  { code: "99341", typical_minutes: 15 },
  { code: "99342", typical_minutes: 30 },
  { code: "99344", typical_minutes: 60 },
  { code: "99345", typical_minutes: 75 },
  { code: "99347", typical_minutes: 20 },
  { code: "99348", typical_minutes: 30 },
  { code: "99349", typical_minutes: 40 },
  { code: "99350", typical_minutes: 60 },
];

const rows = (r: { code: string; typical_minutes: number | null }[]) =>
  vi.mocked(prisma.$queryRaw).mockResolvedValue(r as never);

/** The SQL as the tagged template produced it, plus its bound values. */
function lastQuery() {
  const call = vi.mocked(prisma.$queryRaw).mock.calls.at(-1)!;
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join("¶"), values };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildBands", () => {
  it("runs each band from its own stated time to one minute below the next", () => {
    expect(
      buildBands([
        { code: "99341", typicalMinutes: 15 },
        { code: "99342", typicalMinutes: 30 },
        { code: "99344", typicalMinutes: 60 },
        { code: "99345", typicalMinutes: 75 },
      ]),
    ).toEqual([
      { code: "99341", minMinutes: 15, maxMinutes: 29 },
      { code: "99342", minMinutes: 30, maxMinutes: 59 },
      { code: "99344", minMinutes: 60, maxMinutes: 74 },
      { code: "99345", minMinutes: 75, maxMinutes: Infinity },
    ]);
  });

  it("does not start the first band at zero", () => {
    // A 3-minute visit meets no code's stated time. The old hardcoded ladder
    // started at 0 and silently suggested a full home visit.
    const [first] = buildBands([{ code: "99341", typicalMinutes: 15 }]);
    expect(first!.minMinutes).toBe(15);
  });

  it("leaves the top band open-ended", () => {
    const bands = buildBands([
      { code: "99347", typicalMinutes: 20 },
      { code: "99350", typicalMinutes: 60 },
    ]);
    expect(bands.at(-1)!.maxMinutes).toBe(Infinity);
  });

  it("sorts by time, so row order from the database does not matter", () => {
    const bands = buildBands([
      { code: "99345", typicalMinutes: 75 },
      { code: "99341", typicalMinutes: 15 },
      { code: "99344", typicalMinutes: 60 },
      { code: "99342", typicalMinutes: 30 },
    ]);
    expect(bands.map((b) => b.code)).toEqual(["99341", "99342", "99344", "99345"]);
  });

  it("drops non-positive and non-finite times rather than banding them", () => {
    const bands = buildBands([
      { code: "BAD0", typicalMinutes: 0 },
      { code: "BADN", typicalMinutes: -30 },
      { code: "BADI", typicalMinutes: Number.POSITIVE_INFINITY },
      { code: "BADX", typicalMinutes: Number.NaN },
      { code: "99341", typicalMinutes: 15 },
    ]);
    expect(bands).toEqual([{ code: "99341", minMinutes: 15, maxMinutes: Infinity }]);
  });

  it("returns nothing for no times", () => {
    expect(buildBands([])).toEqual([]);
  });

  it("keeps a single band contiguous when two codes share a stated time", () => {
    // 99342 and 99348 both sit at 30 minutes on their own ladders; within one
    // ladder a tie must still produce non-overlapping bands.
    const bands = buildBands([
      { code: "A", typicalMinutes: 30 },
      { code: "B", typicalMinutes: 30 },
    ]);
    expect(bands[0]!.maxMinutes).toBe(29); // empty, not overlapping B
    expect(bands[1]!.minMinutes).toBe(30);
  });
});

describe("getVisitCodeBands", () => {
  it("builds both ladders from the seeded code times", async () => {
    rows(SEEDED);
    const bands = await getVisitCodeBands();

    expect(bands.newPatientHome.map((b) => [b.code, b.minMinutes, b.maxMinutes])).toEqual([
      ["99341", 15, 29],
      ["99342", 30, 59],
      ["99344", 60, 74],
      ["99345", 75, Infinity],
    ]);
    expect(bands.establishedPatientHome.map((b) => [b.code, b.minMinutes, b.maxMinutes])).toEqual([
      ["99347", 20, 29],
      ["99348", 30, 39],
      ["99349", 40, 59],
      ["99350", 60, Infinity],
    ]);
  });

  it("asks only for the eight home-visit codes", async () => {
    rows(SEEDED);
    await getVisitCodeBands();
    expect(lastQuery().values[0]).toEqual([
      ...NEW_PATIENT_HOME_CODES,
      ...ESTABLISHED_PATIENT_HOME_CODES,
    ]);
  });

  it("reads only the code version in force today", async () => {
    // `code` is versioned by effective_date. A future revision must not change
    // today's suggestion, and an expired one must not linger.
    rows(SEEDED);
    await getVisitCodeBands();
    const { sql } = lastQuery();
    expect(sql).toContain("c.effective_date <= CURRENT_DATE");
    expect(sql).toContain("c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE");
    expect(sql).toContain("DISTINCT ON (c.code)");
    expect(sql).toContain("ORDER BY c.code, c.effective_date DESC");
  });

  it("keeps each ladder to its own codes", async () => {
    rows(SEEDED);
    const bands = await getVisitCodeBands();
    expect(bands.newPatientHome.every((b) => NEW_PATIENT_HOME_CODES.includes(b.code as never))).toBe(
      true,
    );
    expect(
      bands.establishedPatientHome.every((b) =>
        ESTABLISHED_PATIENT_HOME_CODES.includes(b.code as never),
      ),
    ).toBe(true);
  });

  it("drops a code whose typical_minutes is not set, rather than guessing one", async () => {
    // The honest failure: 99345 has no stated time, so 99344 becomes the top
    // band and simply runs to Infinity. Inventing a time here would put the
    // product back in the business of holding its own ladder.
    rows(SEEDED.map((r) => (r.code === "99345" ? { ...r, typical_minutes: null } : r)));
    const bands = await getVisitCodeBands();
    expect(bands.newPatientHome.map((b) => b.code)).toEqual(["99341", "99342", "99344"]);
    expect(bands.newPatientHome.at(-1)!.maxMinutes).toBe(Infinity);
  });

  it("returns empty ladders when the code table says nothing", async () => {
    // The document page renders no suggestion at all in this case — better
    // than a confident wrong one.
    rows([]);
    const bands = await getVisitCodeBands();
    expect(bands).toEqual({ newPatientHome: [], establishedPatientHome: [] });
  });

  it("ignores a row for a code neither ladder claims", async () => {
    rows([...SEEDED, { code: "99497", typical_minutes: 30 }]);
    const bands = await getVisitCodeBands();
    expect([...bands.newPatientHome, ...bands.establishedPatientHome].map((b) => b.code)).not.toContain(
      "99497",
    );
  });

  it("needs no org context — code is global reference data", async () => {
    rows(SEEDED);
    await getVisitCodeBands();
    const { withOrgContext } = await import("@/lib/db");
    expect(withOrgContext).not.toHaveBeenCalled();
  });
});
