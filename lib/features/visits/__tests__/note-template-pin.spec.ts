/**
 * A visit's note is read and written under ONE template version: the version
 * the visit is pinned to, else the org's active template.
 *
 * Product rule: the note editor and the note preview always show the same
 * sections. The preview, audit packet, sign guard and payer documentation
 * check already resolved COALESCE(visit.note_template_id, active). The editor
 * read the ACTIVE template, so once an org edited its template a note written
 * under v1 showed v2's sections in the editor and v1's in the preview, and the
 * next save silently moved the visit onto v2.
 *
 * THE FAKE DATABASE HERE MODELS ROWS IN TABLES and runs note.service's own
 * statements over them, through the pocket SQL evaluator at the foot of this
 * file. It used to answer the resolution query with
 *
 *     const id = (visitId === VISIT ? db.pin : null) ?? (orgId === ORG ? db.active.id : null)
 *
 * — the fake applying COALESCE(pin, active) itself, from the two bind
 * positions, without ever reading the statement. That made the pin's whole
 * reason for existing untested: narrowing the pin subquery with AND FALSE,
 * LIMIT 0 or a status filter, or swapping the two operands so the ACTIVE
 * version wins, left all 12 tests here green and the suite green with them,
 * while on the 45 pinned visits in the local fixture every one of those edits
 * reads, lists and validates an attested note against a version it was never
 * written under. The only thing that went red was a SQL-text parity check
 * between this service and the audit packet — which is satisfied by breaking
 * both files the same way, so it pushed a developer towards exactly that.
 *
 * Nothing below restates the resolution, the set-once pin or the carry-forward
 * copy rule. The tables hold rows — two template versions, a second visit of
 * the same patient, and a decoy visit carrying the same section keys — and the
 * statement under test decides.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { handleServiceError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

import {
  carryForwardSections,
  getCarryForwardSource,
  getVisitNote,
  saveNoteSection,
  saveVitals,
} from "../note.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
const PREV = "e0000000-0000-4000-8000-00000000000a";
/** Another visit of this org, carrying the same section keys as VISIT. */
const DECOY = "e0000000-0000-4000-8000-0000000000de";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "f0000000-0000-4000-8000-000000000002";
/** Another agency on the same database, writing under its own template. */
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

interface TemplateRef { id: string; name: string; version: number }
const V1: TemplateRef = {
  id: "71000000-0000-4000-8000-000000000001", name: "Palliative visit note", version: 1,
};
const V2: TemplateRef = {
  id: "72000000-0000-4000-8000-000000000002", name: "Palliative visit note (2026)", version: 2,
};
/** The other agency's active version. Nothing of this org's is written under it. */
const OTHER_V: TemplateRef = {
  id: "73000000-0000-4000-8000-000000000003", name: "OTHER ORG: Chaplain note", version: 9,
};
const TEMPLATES: Record<string, TemplateRef> = { [V1.id]: V1, [V2.id]: V2 };

interface TemplateSectionRow {
  section_key: string;
  label: string;
  help_text: string | null;
  kind: string;
  is_required: boolean;
  not_required_for_visit_types: string[];
  sort_order: number;
}
const required = (key: string, label: string, order: number): TemplateSectionRow => ({
  section_key: key, label, help_text: null, kind: "prose", is_required: true,
  not_required_for_visit_types: [], sort_order: order,
});

// v2 is what saveNoteTemplate writes when an admin drops HPI and adds a
// required spiritual assessment: one v1-only key, one v2-only key.
const SECTIONS: Record<string, TemplateSectionRow[]> = {
  [V1.id]: [
    required("hpi", "History of present illness", 0),
    required("social_history", "Social history", 1),
    required("assessment_and_plan", "Assessment and plan", 2),
  ],
  [V2.id]: [
    required("social_history", "Social history", 0),
    required("assessment_and_plan", "Assessment and plan", 1),
    required("spiritual_assessment", "Spiritual assessment", 2),
  ],
};

const PROSE = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** A visit_note_section row, as a save or a carry-forward leaves one. */
const sectionRow = (visitId: string, key: string, isEmpty: boolean, text?: string): SqlRow => ({
  org_id: ORG, visit_id: visitId, section_key: key,
  content: isEmpty ? null : PROSE(text ?? "written"),
  is_empty: isEmpty, carried_from_visit_id: null, carried_unchanged: false,
  updated_at: null, updated_by_user_id: null,
});

const visitRow = (id: string, patientId: string, o: Partial<SqlRow> = {}): SqlRow => ({
  id, org_id: ORG, patient_id: patientId, status: "in_progress", note_template_id: null,
  visit_type: "established_patient_home", is_telehealth: false,
  start_time: null, scheduled_start: new Date("2026-09-09T10:00:00Z"), signed_at: null,
  ...o,
});

/** The rows every statement in this file reads and writes. */
let tables: SqlTables;
let calls: { sql: string; values: unknown[] }[] = [];

/** Columns a table fills in itself, for an INSERT that does not name them. */
const TABLE_DEFAULTS: Record<string, SqlRow> = {
  visit_vitals: { recorded_at: new Date("2026-09-09T10:30:00Z") },
  visit_note_section: { carried_from_visit_id: null, carried_unchanged: false },
};

const theVisit = () => tables.visit.find((v) => v.id === VISIT)!;

/**
 * The fixture, as the tests below speak about it. Every one of these reads or
 * writes the tables above — there is no second copy of the state for the fake
 * to answer from.
 */
const db = {
  /** The org's active template version. */
  get active(): TemplateRef {
    const row = tables.note_template.find((t) => t.org_id === ORG && t.is_active === true);
    return TEMPLATES[row!.id as string]!;
  },
  set active(t: TemplateRef) {
    // This org's rows only. The other agency's version stays active, so the
    // resolution always has a foreign row it must not reach.
    for (const row of tables.note_template) {
      if (row.org_id === ORG) row.is_active = row.id === t.id;
    }
  },
  /** visit.note_template_id for VISIT. */
  get pin(): string | null { return theVisit().note_template_id as string | null; },
  set pin(id: string | null) { theVisit().note_template_id = id; },
  get status(): string { return theVisit().status as string; },
  set status(s: string) { theVisit().status = s; },
  /** VISIT's visit_note_section rows: section_key → is_empty. */
  get written(): Map<string, boolean> {
    return new Map(
      tables.visit_note_section
        .filter((r) => r.visit_id === VISIT)
        .map((r) => [r.section_key as string, r.is_empty as boolean]),
    );
  },
  set written(rows: Map<string, boolean>) {
    tables.visit_note_section = tables.visit_note_section.filter((r) => r.visit_id !== VISIT);
    for (const [key, isEmpty] of rows) tables.visit_note_section.push(sectionRow(VISIT, key, isEmpty));
  },
  /** Non-empty sections on the previous signed visit. */
  get prevFilled(): string[] {
    return tables.visit_note_section
      .filter((r) => r.visit_id === PREV && r.is_empty === false)
      .map((r) => r.section_key as string);
  },
  set prevFilled(keys: string[]) {
    tables.visit_note_section = tables.visit_note_section.filter((r) => r.visit_id !== PREV);
    for (const key of keys) {
      tables.visit_note_section.push(sectionRow(PREV, key, false, `carried ${key}`));
    }
  },
};

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    // The statement as the database would see it, binds numbered in place.
    // Every statement is EXECUTED: rows back from a SELECT, rows written from
    // an INSERT or UPDATE, and a throw for anything this fake cannot run —
    // never a canned answer chosen by grepping the SQL.
    const statement = strings.reduce((acc, part, i) => `${acc}$${i - 1}${part}`);
    return Promise.resolve(runSql(statement, values, tables, TABLE_DEFAULTS));
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  tables = {
    visit: [
      visitRow(VISIT, PATIENT, { note_template_id: V1.id }),
      visitRow(PREV, PATIENT, {
        status: "documented",
        note_template_id: V1.id,
        start_time: new Date("2026-09-01T10:00:00Z"),
        signed_at: new Date("2026-09-01T18:00:00Z"),
      }),
      // Another visit of the org, same template version, same section keys.
      visitRow(DECOY, OTHER_PATIENT, { status: "documented", note_template_id: V1.id }),
    ],
    note_template: [
      // The other agency's active version, FIRST in the table: `LIMIT 1` with
      // no ORDER BY takes whichever row comes back first, so a resolution that
      // stopped filtering by org reaches this one. Nothing here enforces RLS,
      // which is what a connection that bypasses it — the preview
      // deployment's — sees.
      {
        id: OTHER_V.id, org_id: OTHER_ORG, name: OTHER_V.name, version: OTHER_V.version,
        is_active: true, source: "edited",
      },
      ...[V1, V2].map((t) => ({
        id: t.id, org_id: ORG, name: t.name, version: t.version, is_active: t.id === V2.id,
        source: "edited",
      })),
    ],
    note_template_section: [
      // The section that widened resolution would list, and offer, and
      // validate this org's notes against.
      {
        ...required("chaplain_visit", "OTHER ORG: Chaplain visit", 0),
        org_id: OTHER_ORG, template_id: OTHER_V.id,
      },
      ...Object.entries(SECTIONS).flatMap(([templateId, rows]) =>
        rows.map((r) => ({ ...r, org_id: ORG, template_id: templateId })),
      ),
    ],
    visit_note_section: [],
    visit_vitals: [],
    org_visit_type: [],
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("getVisitNote reads the visit's own template version", () => {
  it("shows a v1-pinned visit v1's sections, requirements, name and version while v2 is active", async () => {
    db.written = new Map([["hpi", false], ["assessment_and_plan", false]]);

    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });

    expect(n.sections.map((s) => s.sectionKey)).toEqual(["hpi", "social_history", "assessment_and_plan"]);
    // v1's own required-and-empty list: the one the sign guard enforces for
    // this visit. v2's spiritual assessment is not owed on a v1 note.
    expect(n.missingRequired).toEqual([{ sectionKey: "social_history", label: "Social history" }]);
    expect({ id: n.templateId, name: n.templateName, version: n.templateVersion }).toEqual(V1);

    // CONTROL: the same visit unpinned follows the active v2, as it did before.
    db.pin = null;
    const u = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(u.sections.map((s) => s.sectionKey)).toEqual(["social_history", "assessment_and_plan", "spiritual_assessment"]);
    expect(u.missingRequired.map((m) => m.sectionKey)).toEqual(["social_history", "spiritual_assessment"]);
    expect({ id: u.templateId, name: u.templateName, version: u.templateVersion }).toEqual(V2);
  });

  it("falls back to THIS org's active version, never another agency's", async () => {
    // The fallback half of the COALESCE is `WHERE nt.org_id = ¶::uuid AND
    // nt.is_active LIMIT 1`. Deleting the org predicate used to be caught only
    // by the SQL-text parity check at the foot of this file — which is
    // satisfied by breaking both files the same way — because every template
    // row here belonged to one org, so there was no foreign active version for
    // the widened lookup to reach. There is one now, first in the table, where
    // `LIMIT 1` without ORDER BY takes it: widened, every unpinned visit in
    // this org is edited, listed, carried forward and validated against
    // another agency's sections, and a save attests to them.
    db.pin = null;
    db.written = new Map([["social_history", false]]);

    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });

    expect({ id: n.templateId, name: n.templateName, version: n.templateVersion }).toEqual(V2);
    expect(n.sections.map((s) => s.sectionKey)).toEqual([
      "social_history", "assessment_and_plan", "spiritual_assessment",
    ]);
  });

  it("resolves the pin from the visit and the org alone, wherever the visit has got to", async () => {
    // The resolution asks which VERSION the note is written under. The visit's
    // progress is a different fact and must not narrow the lookup: this same
    // resolver runs for a scheduled visit's first read, an in-progress edit, a
    // signed note's preview and a cancelled visit's correction.
    //
    // No pinned visit can be back at 'scheduled' today — the three writers
    // that set the pin (saveNoteSection, saveVitals, carryForwardSections)
    // each move a scheduled visit to in_progress in the same UPDATE — but that
    // invariant lives in three separate statements, and a status predicate
    // creeping in here would silently resolve an attested v1 note against v2.
    db.written = new Map([["hpi", false]]);
    for (const status of ["scheduled", "in_progress", "documented", "cancelled"]) {
      db.status = status;
      const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
      expect({ status, version: n.templateVersion }).toEqual({ status, version: 1 });
      expect(n.sections.map((s) => s.sectionKey)).toContain("hpi");
    }
  });

  it("shows only this visit's own section text, never another visit's", async () => {
    // The editor's list joins `ON s.visit_id = ¶::uuid AND s.section_key =
    // t.section_key`, the same clause as the audit packet's. Without the first
    // half, every key of the template joins to every row with that key in the
    // org: the editor would open on another patient's paragraph and the next
    // save would attest to it.
    db.written = new Map([["hpi", false]]);
    tables.visit_note_section.push(
      sectionRow(DECOY, "hpi", false, "OTHER PATIENT: chest pain since Tuesday."),
      sectionRow(DECOY, "social_history", false, "OTHER PATIENT: lives alone."),
    );

    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });

    expect(n.sections.map((s) => s.sectionKey)).toEqual(["hpi", "social_history", "assessment_and_plan"]);
    expect(JSON.stringify(n.sections)).not.toContain("OTHER PATIENT");
    expect(n.sections.find((s) => s.sectionKey === "social_history")!.isEmpty).toBe(true);
  });
});

describe("saveNoteSection validates and pins against the visit's own template version", () => {
  it("accepts a v1-only key on a v1-pinned visit and leaves the pin at v1", async () => {
    const r = await saveNoteSection({
      orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("Breathless on exertion."),
    });

    expect(r).toEqual({ updated: true, isEmpty: false });
    expect(calls.find((c) => c.sql.includes("SELECT kind FROM note_template_section"))!.values[0]).toBe(V1.id);
    expect(db.pin).toBe(V1.id);
    // Set once, never moved: the statement itself keeps an existing pin.
    expect(calls.find((c) => c.sql.includes("UPDATE visit"))!.sql).toContain(
      "SET note_template_id = COALESCE(note_template_id, ¶::uuid)",
    );
  });

  it("refuses a v2-only key on a v1-pinned visit with a 422 that names the version", async () => {
    const err = await saveNoteSection({
      orgId: ORG, visitId: VISIT, sectionKey: "spiritual_assessment", content: PROSE("x"),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(
      /"spiritual_assessment" is not a section of this org's note template version 1, the version this visit's note is written under/,
    );
    expect(handleServiceError(err).status).toBe(422);
    expect(db.written.has("spiritual_assessment")).toBe(false);
    expect(db.pin).toBe(V1.id);
  });

  it("CONTROL: pins an unpinned visit to the active template on its first save", async () => {
    db.pin = null;
    await saveNoteSection({
      orgId: ORG, visitId: VISIT, sectionKey: "spiritual_assessment", content: PROSE("Finds meaning in faith."),
    });
    expect(db.pin).toBe(V2.id);

    // And unpinned still means today's rule: a key only v1 declares is refused.
    db.pin = null;
    await expect(
      saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("x") }),
    ).rejects.toThrow(/note template version 2/);
  });
});

describe("carry-forward offers and copies only what the current visit's template declares", () => {
  beforeEach(() => {
    db.prevFilled = ["hpi", "assessment_and_plan", "spiritual_assessment"];
  });

  it("offers a v1-pinned visit v1's keys under v1's labels", async () => {
    const s = await getCarryForwardSource({ orgId: ORG, visitId: VISIT });
    expect(s!.sections).toEqual([
      { sectionKey: "hpi", label: "History of present illness" },
      { sectionKey: "assessment_and_plan", label: "Assessment and plan" },
    ]);

    // CONTROL: unpinned, the offer follows the active v2.
    db.pin = null;
    const u = await getCarryForwardSource({ orgId: ORG, visitId: VISIT });
    expect(u!.sections.map((x) => x.sectionKey)).toEqual(["assessment_and_plan", "spiritual_assessment"]);
  });

  it("skips a key the visit's template does not declare, and keeps an existing pin", async () => {
    const r = await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi", "spiritual_assessment"],
    });
    expect(r).toEqual({ copied: ["hpi"], skipped: ["spiritual_assessment"] });
    expect(db.pin).toBe(V1.id);
    expect(db.written.get("hpi")).toBe(false);
  });

  it("leaves a PINNED visit's pin alone when it copies nothing at all", async () => {
    // The case the two tests above cannot distinguish: the only key chosen is
    // one this visit's version does not declare, so nothing is written and the
    // statement binds NULL over a live pin. COALESCE keeps the pin; a bare
    // assignment writes the NULL, and the note silently loses the version it
    // was started under — the exact failure the pin exists to prevent, reached
    // through a no-op user action.
    const r = await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["spiritual_assessment"],
    });
    expect(r).toEqual({ copied: [], skipped: ["spiritual_assessment"] });
    expect(db.pin).toBe(V1.id);
  });

  it("never overwrites a section already written on this visit", async () => {
    // "I brought the history forward but wrote today's exam myself" is the
    // normal shape of a follow-up note. The copy's ON CONFLICT ... WHERE
    // visit_note_section.is_empty is what keeps the clinician's own paragraph.
    db.written = new Map([["hpi", false]]);
    const mine = tables.visit_note_section.find((r) => r.visit_id === VISIT)!;
    mine.content = PROSE("Today: much more breathless than last week.");

    const r = await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"],
    });

    expect(r).toEqual({ copied: [], skipped: ["hpi"] });
    expect(JSON.stringify(mine.content)).toContain("much more breathless");
  });

  it("pins a note it starts, and leaves an unpinned visit alone when it copies nothing", async () => {
    db.pin = null;
    const r = await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["assessment_and_plan"],
    });
    expect(r.copied).toEqual(["assessment_and_plan"]);
    expect(db.pin).toBe(V2.id);

    // CONTROL: nothing copied means nothing written, so no pin either.
    db.pin = null;
    db.written = new Map();
    const none = await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"],
    });
    expect(none).toEqual({ copied: [], skipped: ["hpi"] });
    expect(db.pin).toBeNull();
  });
});

describe("saveVitals pins the note the way a section save does", () => {
  it("keeps a vitals-only note on the version it was started under after a template edit", async () => {
    db.active = V1;
    db.pin = null;
    await saveVitals({ orgId: ORG, visitId: VISIT, vitals: { weightKg: 61.4 } });
    expect(db.pin).toBe(V1.id);
    expect(calls.find((c) => c.sql.includes("UPDATE visit"))!.sql).toContain(
      "SET note_template_id = COALESCE(note_template_id, ¶::uuid)",
    );

    // The admin saves v2, which drops HPI. The note started under v1 keeps it.
    db.active = V2;
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.templateVersion).toBe(1);
    expect(n.sections.map((s) => s.sectionKey)).toContain("hpi");
  });

  it("CONTROL: a later vitals correction never moves an existing pin", async () => {
    // v1-pinned while v2 is active: a bare assignment would move it to v2.
    await saveVitals({ orgId: ORG, visitId: VISIT, vitals: { weightKg: 61.2 } });
    expect(db.pin).toBe(V1.id);
  });
});

describe("the resolution fails loudly rather than falling back", () => {
  const DANGLING = "79000000-0000-4000-8000-000000000009";

  it("throws an internal error when the visit's pin names no template the org can see", async () => {
    db.pin = DANGLING;
    const err = await getVisitNote({ orgId: ORG, visitId: VISIT }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/did not resolve/);
    expect(handleServiceError(err).status).toBe(500);
    // Nothing was read under a stand-in version.
    expect(calls.some((c) => c.sql.includes("FROM note_template_section t"))).toBe(false);

    // CONTROL: the same visit unpinned resolves to the active version.
    db.pin = null;
    expect((await getVisitNote({ orgId: ORG, visitId: VISIT })).templateVersion).toBe(2);
  });

  it("a copy with the visit and org binds swapped reads and writes nothing", async () => {
    // Every resolution query is handed its two values in the opposite order,
    // exactly what the resolver would send with the binds swapped in its SQL.
    // Before, the fake ignored its values and the resolver fell back to the
    // active version, so that typo passed every test.
    const swappedTx = () => {
      const tx = fakeTx();
      return {
        ...tx,
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
          strings.join("¶").includes("FROM note_template tpl")
            ? tx.$queryRaw(strings, values[1], values[0])
            : tx.$queryRaw(strings, ...values),
      };
    };
    vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
      (fn as (tx: unknown) => Promise<unknown>)(swappedTx()),
    );

    await expect(getVisitNote({ orgId: ORG, visitId: VISIT })).rejects.toThrow(/did not resolve/);
    await expect(
      saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("x") }),
    ).rejects.toThrow(/did not resolve/);
    expect(db.written.size).toBe(0);
    expect(db.pin).toBe(V1.id);

    // CONTROL: bound in order, the same v1-pinned visit reads v1.
    vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
      (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
    );
    expect((await getVisitNote({ orgId: ORG, visitId: VISIT })).templateVersion).toBe(1);
  });
});

describe("the resolution is the preview's", () => {
  it("uses the same COALESCE, with the same value in each bind, as the audit packet's section query", async () => {
    // Each interpolation is replaced by WHAT it binds, the visit id or the org
    // id, rather than blanked, so swapping the two in either query fails this
    // as well as the behaviour above. Whitespace collapses.
    //
    // This is a parity check and nothing more: breaking both files the same
    // way satisfies it. What stops that is behaviour — the tests above for
    // this file, and audit-packet-load.spec.ts's own modelled rows for the
    // packet's copy.
    const expr = /COALESCE\(\s*\(SELECT note_template_id FROM visit[\s\S]*?is_active LIMIT 1\)\)/;
    const squash = (s: string) => s.replace(/\s+/g, " ");
    const byName: Record<string, string> = { visitId: "‹visit›", orgId: "‹org›" };
    const byValue = (v: unknown) => (v === VISIT ? "‹visit›" : v === ORG ? "‹org›" : "‹?›");

    const packetSrc = readFileSync(new URL("../audit-packet.service.ts", import.meta.url), "utf8");
    const packet = packetSrc.match(expr)?.[0];
    expect(packet).toBeDefined();
    const packetTagged = squash(
      packet!.replace(/\$\{\s*(\w+)\s*\}/g, (_m, name: string) => byName[name] ?? `‹${name}?›`),
    );
    expect(packetTagged).toContain("FROM visit WHERE id = ‹visit›::uuid");
    expect(packetTagged).toContain("nt.org_id = ‹org›::uuid");

    await getVisitNote({ orgId: ORG, visitId: VISIT });
    const call = calls.find((c) => c.sql.includes("FROM note_template tpl"))!;
    const tagged = call.sql.split("¶").reduce((acc, part, i) => acc + byValue(call.values[i - 1]) + part);
    const ours = tagged.match(expr)?.[0];
    expect(ours).toBeDefined();
    expect(squash(ours!)).toBe(packetTagged);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * A pocket SQL evaluator.
 *
 * Enough of SELECT, INSERT and UPDATE to RUN note.service's own statements
 * over the tables above: FROM, LEFT/INNER JOIN with a real ON predicate,
 * WHERE, scalar subqueries, COALESCE, CASE, IN, ORDER BY, LIMIT, INSERT …
 * SELECT and INSERT … VALUES with ON CONFLICT DO UPDATE, and UPDATE … SET.
 *
 * It knows nothing about visits, templates or pins — it evaluates whatever the
 * statement says, which is why a predicate deleted from the service changes
 * what these tests see. A statement it cannot run throws rather than quietly
 * answering.
 * ──────────────────────────────────────────────────────────────────────────── */

type SqlRow = Record<string, unknown>;
type SqlTables = Record<string, SqlRow[]>;
type SqlScope = Record<string, SqlRow | null>;
interface SqlCtx {
  scope: SqlScope;
  binds: unknown[];
  tables: SqlTables;
  defaults: Record<string, SqlRow>;
}
type SqlExpr = (c: SqlCtx) => unknown;
type SqlQuery = (c: SqlCtx) => SqlRow[];

/** Words that can never be a column alias, so `x AS` may be left implicit. */
const SQL_WORDS = new Set([
  "AND", "AS", "ASC", "BY", "CASE", "CONFLICT", "DESC", "DO", "ELSE", "END", "EXCLUDED", "FROM",
  "GROUP", "IN", "INNER", "INSERT", "INTO", "IS", "JOIN", "LEFT", "LIMIT", "NOT", "NOTHING",
  "NULL", "ON", "OR", "ORDER", "OUTER", "RETURNING", "SELECT", "SET", "THEN", "TRUE", "FALSE",
  "UPDATE", "VALUES", "WHEN", "WHERE",
]);

function sqlTokens(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && sql[j] !== "'") j++;
      out.push(sql.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (sql.startsWith("::", i)) { out.push("::"); i += 2; continue; }
    const two = sql.slice(i, i + 2);
    if (two === "<>" || two === "!=" || two === ">=" || two === "<=") { out.push(two); i += 2; continue; }
    if ("(),.=<>*+-/[]".includes(c)) { out.push(c); i++; continue; }
    if (c === "$") {
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j]!)) j++;
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < sql.length && /[\d.]/.test(sql[j]!)) j++;
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`sql: unexpected character ${c}`);
  }
  return out;
}

const sqlTruthy = (v: unknown) => v === true;
const sqlKey = (v: unknown) => (v instanceof Date ? v.getTime() : v);

/** Three-valued logic: NULL is neither true nor false, as in Postgres. */
const sqlAnd = (a: unknown, b: unknown) =>
  a === false || b === false ? false : a == null || b == null ? null : true;
const sqlOr = (a: unknown, b: unknown) =>
  a === true || b === true ? true : a == null || b == null ? null : false;

function sqlCompare(op: string, a: unknown, b: unknown): boolean | null {
  if (a == null || b == null) return null;
  const x = sqlKey(a) as never;
  const y = sqlKey(b) as never;
  switch (op) {
    case "=": return x === y;
    case "<>": case "!=": return x !== y;
    case "<": return x < y;
    case ">": return x > y;
    case "<=": return x <= y;
    case ">=": return x >= y;
    default: throw new Error(`sql: unsupported operator ${op}`);
  }
}

/** NULLS LAST for ASC, as Postgres orders. */
function sqlOrderBy(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const x = sqlKey(a) as never;
  const y = sqlKey(b) as never;
  return x < y ? -1 : x > y ? 1 : 0;
}

function sqlLookup(c: SqlCtx, owner: string | null, column: string): unknown {
  if (owner) {
    const name = Object.keys(c.scope).find((k) => k.toLowerCase() === owner.toLowerCase());
    if (name === undefined) throw new Error(`sql: nothing named "${owner}" is in scope`);
    const row = c.scope[name];
    if (!row) return null; // a LEFT JOIN miss reads as NULL, which is what COALESCE is for
    if (!(column in row)) throw new Error(`sql: "${owner}" has no column "${column}"`);
    return row[column] ?? null;
  }
  const holders = Object.values(c.scope).filter((r): r is SqlRow => !!r && column in r);
  if (holders.length === 0) throw new Error(`sql: no table in scope has a column "${column}"`);
  if (holders.length > 1) throw new Error(`sql: "${column}" is ambiguous — qualify it`);
  return holders[0]![column] ?? null;
}

class SqlParser {
  private i = 0;

  constructor(private readonly t: string[]) {}

  private peek(n = 0): string { return this.t[this.i + n] ?? ""; }
  private up(n = 0): string { return this.peek(n).toUpperCase(); }
  private next(): string {
    const v = this.t[this.i];
    if (v === undefined) throw new Error("sql: statement ended early");
    this.i += 1;
    return v;
  }
  private eat(word: string): boolean {
    if (this.up() === word) { this.i += 1; return true; }
    return false;
  }
  private expect(word: string): void {
    if (!this.eat(word)) throw new Error(`sql: expected ${word}, found "${this.peek()}"`);
  }

  /** SELECT rows, or the number of rows an INSERT or UPDATE wrote. */
  statement(): (c: SqlCtx) => SqlRow[] | number {
    if (this.up() === "SELECT") return this.select();
    if (this.up() === "INSERT") return this.insert();
    if (this.up() === "UPDATE") return this.update();
    throw new Error(`sql: this fake runs no "${this.peek()}" statement`);
  }

  select(): SqlQuery {
    this.expect("SELECT");
    const items: { name: string; expr: SqlExpr }[] = [];
    do {
      const start = this.i;
      const expr = this.expr();
      const consumed = this.t.slice(start, this.i);
      let name =
        consumed.length === 1 && /^[A-Za-z_]/.test(consumed[0]!)
          ? consumed[0]!
          : consumed.length === 3 && consumed[1] === "."
            ? consumed[2]!
            : `col${items.length}`;
      if (this.eat("AS")) name = this.next();
      else if (/^[A-Za-z_]/.test(this.peek()) && !SQL_WORDS.has(this.up())) name = this.next();
      items.push({ name, expr });
    } while (this.eat(","));

    this.expect("FROM");
    const from = this.tableRef();
    const joins: { table: string; alias: string; on: SqlExpr; left: boolean }[] = [];
    for (;;) {
      const left = this.eat("LEFT");
      if (left) this.eat("OUTER");
      else this.eat("INNER");
      if (!this.eat("JOIN")) {
        if (left) throw new Error("sql: LEFT without JOIN");
        break;
      }
      const ref = this.tableRef();
      this.expect("ON");
      joins.push({ ...ref, on: this.expr(), left });
    }
    const where = this.eat("WHERE") ? this.expr() : null;
    const order: { key: SqlExpr; sign: number }[] = [];
    if (this.eat("ORDER")) {
      this.expect("BY");
      do {
        const key = this.expr();
        const sign = this.eat("DESC") ? -1 : (this.eat("ASC"), 1);
        order.push({ key, sign });
      } while (this.eat(","));
    }
    const limit = this.eat("LIMIT") ? Number(this.next()) : null;

    return (c) => {
      let rows: SqlScope[] = this.rowsOf(c, from.table).map((r) => ({ [from.alias]: r }));
      for (const j of joins) {
        const candidates = this.rowsOf(c, j.table);
        const out: SqlScope[] = [];
        for (const scope of rows) {
          const hits = candidates.filter((r) =>
            sqlTruthy(j.on({ ...c, scope: { ...scope, [j.alias]: r } })),
          );
          if (hits.length > 0) for (const r of hits) out.push({ ...scope, [j.alias]: r });
          else if (j.left) out.push({ ...scope, [j.alias]: null });
        }
        rows = out;
      }
      if (where) rows = rows.filter((scope) => sqlTruthy(where({ ...c, scope })));
      if (order.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const o of order) {
            const d = sqlOrderBy(o.key({ ...c, scope: a }), o.key({ ...c, scope: b })) * o.sign;
            if (d !== 0) return d;
          }
          return 0;
        });
      }
      if (limit !== null) rows = rows.slice(0, limit);
      return rows.map((scope) =>
        Object.fromEntries(items.map((it) => [it.name, it.expr({ ...c, scope })])),
      );
    };
  }

  /** INSERT … SELECT / VALUES, with ON CONFLICT … DO UPDATE. */
  private insert(): (c: SqlCtx) => number {
    this.expect("INSERT");
    this.expect("INTO");
    const table = this.next();
    const columns = this.nameList();
    let source: SqlQuery;
    if (this.up() === "SELECT") source = this.select();
    else {
      this.expect("VALUES");
      this.expect("(");
      const values: SqlExpr[] = [];
      do { values.push(this.expr()); } while (this.eat(","));
      this.expect(")");
      source = (c) => [Object.fromEntries(values.map((v, i) => [`col${i}`, v(c)]))];
    }
    let conflict: { keys: string[]; sets: { column: string; expr: SqlExpr }[]; where: SqlExpr | null } | null = null;
    if (this.eat("ON")) {
      this.expect("CONFLICT");
      const keys = this.nameList();
      this.expect("DO");
      if (this.eat("NOTHING")) conflict = { keys, sets: [], where: null };
      else {
        this.expect("UPDATE");
        this.expect("SET");
        const sets = this.assignments();
        conflict = { keys, sets, where: this.eat("WHERE") ? this.expr() : null };
      }
    }
    if (this.up() === "RETURNING") throw new Error("sql: this fake does not run RETURNING");

    return (c) => {
      const produced = source({ ...c, scope: {} });
      const target = this.rowsOf(c, table);
      let written = 0;
      for (const row of produced) {
        const incoming = Object.fromEntries(
          columns.map((col, i) => [col, Object.values(row)[i] ?? null]),
        );
        const candidate = { ...(c.defaults[table] ?? {}), ...incoming };
        const existing = conflict
          ? target.find((r) => conflict!.keys.every((k) => sqlKey(r[k]) === sqlKey(candidate[k])))
          : undefined;
        if (!existing) {
          target.push(candidate);
          written += 1;
          continue;
        }
        if (!conflict || conflict.sets.length === 0) continue;
        const scope: SqlScope = { [table]: existing, EXCLUDED: candidate };
        if (conflict.where && !sqlTruthy(conflict.where({ ...c, scope }))) continue;
        const next = conflict.sets.map((s) => [s.column, s.expr({ ...c, scope })] as const);
        for (const [column, value] of next) existing[column] = value;
        written += 1;
      }
      return written;
    };
  }

  private update(): (c: SqlCtx) => number {
    this.expect("UPDATE");
    const table = this.next();
    this.expect("SET");
    const sets = this.assignments();
    const where = this.eat("WHERE") ? this.expr() : null;
    return (c) => {
      let written = 0;
      for (const row of this.rowsOf(c, table)) {
        const scope: SqlScope = { [table]: row };
        if (where && !sqlTruthy(where({ ...c, scope }))) continue;
        // Every assignment reads the row as it was before the statement.
        const next = sets.map((s) => [s.column, s.expr({ ...c, scope })] as const);
        for (const [column, value] of next) row[column] = value;
        written += 1;
      }
      return written;
    };
  }

  private assignments(): { column: string; expr: SqlExpr }[] {
    const sets: { column: string; expr: SqlExpr }[] = [];
    do {
      const column = this.next();
      this.expect("=");
      sets.push({ column, expr: this.expr() });
    } while (this.eat(","));
    return sets;
  }

  private nameList(): string[] {
    this.expect("(");
    const names: string[] = [];
    do { names.push(this.next()); } while (this.eat(","));
    this.expect(")");
    return names;
  }

  private rowsOf(c: SqlCtx, table: string): SqlRow[] {
    const rows = c.tables[table];
    if (!rows) throw new Error(`sql: this fake models no table "${table}"`);
    return rows;
  }

  private tableRef(): { table: string; alias: string } {
    const table = this.next();
    const alias =
      /^[A-Za-z_]/.test(this.peek()) && !SQL_WORDS.has(this.up()) ? this.next() : table;
    return { table, alias };
  }

  expr(): SqlExpr { return this.or(); }

  private or(): SqlExpr {
    let left = this.and();
    while (this.eat("OR")) {
      const right = this.and();
      const l = left;
      left = (c) => sqlOr(l(c), right(c));
    }
    return left;
  }

  private and(): SqlExpr {
    let left = this.not();
    while (this.eat("AND")) {
      const right = this.not();
      const l = left;
      left = (c) => sqlAnd(l(c), right(c));
    }
    return left;
  }

  private not(): SqlExpr {
    if (this.eat("NOT")) {
      const e = this.not();
      return (c) => {
        const v = e(c);
        return v == null ? null : !v;
      };
    }
    return this.comparison();
  }

  private comparison(): SqlExpr {
    const left = this.atom();
    const op = this.up();
    if (["=", "<>", "!=", "<", ">", "<=", ">="].includes(op)) {
      this.i += 1;
      const right = this.atom();
      return (c) => sqlCompare(op, left(c), right(c));
    }
    if (this.eat("IS")) {
      const negated = this.eat("NOT");
      this.expect("NULL");
      return (c) => (negated ? left(c) != null : left(c) == null);
    }
    if (this.eat("IN")) {
      this.expect("(");
      const options: SqlExpr[] = [];
      do { options.push(this.expr()); } while (this.eat(","));
      this.expect(")");
      return (c) => {
        const v = left(c);
        if (v == null) return null;
        return options.some((o) => sqlCompare("=", v, o(c)) === true);
      };
    }
    return left;
  }

  private atom(): SqlExpr {
    let e: SqlExpr;
    if (this.eat("(")) {
      if (this.up() === "SELECT") {
        const query = this.select();
        this.expect(")");
        // A scalar subquery: its first column, or NULL when it finds nothing.
        // Uncorrelated, which is all these statements use — a correlated one
        // would throw below rather than quietly read an outer row.
        e = (c) => {
          const rows = query({ ...c, scope: {} });
          return rows[0] ? (Object.values(rows[0])[0] ?? null) : null;
        };
      } else {
        const inner = this.expr();
        this.expect(")");
        e = inner;
      }
    } else if (this.up() === "COALESCE" && this.peek(1) === "(") {
      this.i += 2;
      const args: SqlExpr[] = [];
      do { args.push(this.expr()); } while (this.eat(","));
      this.expect(")");
      e = (c) => {
        for (const a of args) {
          const v = a(c);
          if (v != null) return v;
        }
        return null;
      };
    } else if (this.up() === "NOW" && this.peek(1) === "(" && this.peek(2) === ")") {
      this.i += 3;
      e = () => new Date();
    } else if (this.eat("CASE")) {
      const arms: { when: SqlExpr; then: SqlExpr }[] = [];
      while (this.eat("WHEN")) {
        const when = this.expr();
        this.expect("THEN");
        arms.push({ when, then: this.expr() });
      }
      const otherwise = this.eat("ELSE") ? this.expr() : null;
      this.expect("END");
      e = (c) => {
        for (const arm of arms) if (sqlTruthy(arm.when(c))) return arm.then(c);
        return otherwise ? otherwise(c) : null;
      };
    } else if (this.eat("TRUE")) e = () => true;
    else if (this.eat("FALSE")) e = () => false;
    else if (this.eat("NULL")) e = () => null;
    else {
      const token = this.next();
      if (token.startsWith("'")) {
        const literal = token.slice(1, -1);
        e = () => literal;
      } else if (token.startsWith("$")) {
        const n = Number(token.slice(1));
        e = (c) => c.binds[n] ?? null;
      } else if (/^\d/.test(token)) {
        const n = Number(token);
        e = () => n;
      } else if (/^[A-Za-z_]/.test(token)) {
        let owner: string | null = null;
        let column = token;
        if (this.peek() === ".") {
          this.i += 1;
          owner = token;
          column = this.next();
        }
        e = (c) => sqlLookup(c, owner, column);
      } else {
        throw new Error(`sql: unexpected token "${token}"`);
      }
    }
    // A cast changes no row this fake holds; `::text[]` carries two more.
    while (this.peek() === "::") {
      this.i += 2;
      if (this.peek() === "[") this.i += 2;
    }
    return e;
  }

  end(): void {
    if (this.i < this.t.length) {
      throw new Error(`sql: unread tail at "${this.t.slice(this.i, this.i + 6).join(" ")}"`);
    }
  }
}

/**
 * Run one statement, with `$0`-numbered binds, over the modelled tables:
 * the rows a SELECT returns, or the number of rows an INSERT or UPDATE wrote.
 */
function runSql(
  sql: string,
  binds: unknown[],
  tables: SqlTables,
  defaults: Record<string, SqlRow> = {},
): SqlRow[] | number {
  const parser = new SqlParser(sqlTokens(sql));
  const statement = parser.statement();
  parser.end();
  return statement({ scope: {}, binds, tables, defaults });
}
