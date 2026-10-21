/**
 * The structured visit note: template resolution, section writes, vitals,
 * and carrying a note forward.
 *
 * This was the largest untested surface in the note work — every behaviour
 * below was previously verified only by driving the browser, including the
 * refusals that stop an attested note being rewritten and the guard that stops
 * one patient's history being copied onto another patient's note.
 *
 * lib/db is mocked with a fake tx that dispatches on SQL text, the pattern
 * document-lock.spec.ts established. Each test declares what the database
 * would answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { DEFAULT_NOTE_SECTIONS } from "../note-template";
import {
  carryForwardSections,
  ensureNoteTemplate,
  getCarryForwardSource,
  getVisitNote,
  getVitalsTrend,
  hasAnyMeasurement,
  hasAnyReading,
  noteHasContent,
  saveNoteSection,
  saveNoteTemplate,
  saveVitals,
  EMPTY_VITALS,
  type TemplateSectionInput,
} from "../note.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const PREV = "e0000000-0000-4000-8000-00000000000b";
const PATIENT = "f0000000-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEMPLATE = "77777777-7777-4777-8777-777777777777";

const PROSE = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const BLANK_PROSE = { type: "doc", content: [{ type: "paragraph" }] };

/** What the fake database answers. Each test overrides what it cares about. */
let db: {
  activeTemplate: { id: string; name: string; version: number } | null;
  visit: { status: string; patient_id: string; visit_type?: string; is_telehealth?: boolean } | null;
  sectionKind: string | null;
  noteRows: Record<string, unknown>[];
  vitalsRow: Record<string, unknown> | null;
  filledSectionCount: number;
  prevVisit: { id: string; dos: Date | null; label: string | null } | null;
  prevSections: { section_key: string; label: string }[];
  sourceVisitValid: boolean;
  trendRows: Record<string, unknown>[];
  /** Visits with vitals this patient has in all — more than trendRows when capped. */
  trendTotal: number;
  /** Rows the next INSERT ... SELECT reports as written. */
  insertResult: number;
};

let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });

    if (sql.includes("SELECT id, name, version FROM note_template")) {
      return Promise.resolve(db.activeTemplate ? [db.activeTemplate] : []);
    }
    // The per-visit template resolution. Every visit in this file is unpinned,
    // so it resolves to the active template; pinned visits are exercised in
    // note-template-pin.spec.ts.
    if (sql.includes("FROM note_template tpl")) {
      return Promise.resolve(db.activeTemplate ? [db.activeTemplate] : []);
    }
    if (sql.includes("COALESCE(MAX(version), 0) + 1")) return Promise.resolve([{ v: 4 }]);
    if (sql.includes("INSERT INTO note_template ")) return Promise.resolve([{ id: TEMPLATE }]);
    if (sql.includes("SELECT kind FROM note_template_section")) {
      return Promise.resolve(db.sectionKind ? [{ kind: db.sectionKind }] : []);
    }
    if (sql.includes("FROM note_template_section t")) return Promise.resolve(db.noteRows);
    if (sql.includes("SELECT visit_type, is_telehealth FROM visit")) {
      return Promise.resolve(
        db.visit
          ? [{ visit_type: db.visit.visit_type ?? null, is_telehealth: db.visit.is_telehealth ?? false }]
          : [],
      );
    }
    if (sql.includes("SELECT status, patient_id FROM visit")) {
      return Promise.resolve(db.visit ? [db.visit] : []);
    }
    if (sql.includes("SELECT status FROM visit")) {
      return Promise.resolve(db.visit ? [{ status: db.visit.status }] : []);
    }
    if (sql.includes("FROM visit cur")) return Promise.resolve(db.prevVisit ? [db.prevVisit] : []);
    if (sql.includes("JOIN note_template_section t")) return Promise.resolve(db.prevSections);
    if (sql.includes("AND patient_id =")) {
      return Promise.resolve(db.sourceVisitValid ? [{ id: PREV }] : []);
    }
    // Before the trend-rows branch: the count matches that predicate too.
    if (sql.includes("COUNT(*)::bigint AS n")) {
      return Promise.resolve([{ n: BigInt(db.trendTotal) }]);
    }
    if (sql.includes("WHERE vv.patient_id =")) return Promise.resolve(db.trendRows);
    if (sql.includes("count(*) AS n FROM visit_note_section")) {
      return Promise.resolve([{ n: BigInt(db.filledSectionCount) }]);
    }
    if (sql.includes("FROM visit_vitals WHERE visit_id")) {
      return Promise.resolve(db.vitalsRow ? [db.vitalsRow] : []);
    }
    if (sql.includes("INSERT INTO visit_note_section")) return Promise.resolve(db.insertResult);

    // The one statement this fake EXECUTES rather than answers.
    //
    // Every branch above hands back a row set; this one applies the visit's
    // status assignment to db.visit, so a test can assert the state that
    // RESULTS instead of the SQL text that produced it. It reads the
    // assignment the way Postgres would — the guarded CASE moves only a
    // scheduled visit, a bare literal moves whatever it finds — so a future
    // `SET status = 'in_progress'` written without the CASE puts a cancelled
    // visit back on the round here exactly as it would in the database.
    if (sql.includes("UPDATE visit") && db.visit) {
      const guarded =
        /status = CASE WHEN status = '(\w+)' THEN '(\w+)' ELSE status END/.exec(sql);
      const bare = /status = '(\w+)'/.exec(sql);
      if (guarded) {
        if (db.visit.status === guarded[1]) db.visit.status = guarded[2]!;
      } else if (bare) {
        db.visit.status = bare[1]!;
      }
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const find = (frag: string) => calls.find((c) => c.sql.includes(frag));
const ran = (frag: string) => calls.some((c) => c.sql.includes(frag));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  db = {
    activeTemplate: { id: TEMPLATE, name: "Palliative visit note", version: 1 },
    visit: { status: "in_progress", patient_id: PATIENT },
    sectionKind: "prose",
    noteRows: [],
    vitalsRow: null,
    filledSectionCount: 0,
    prevVisit: null,
    prevSections: [],
    sourceVisitValid: true,
    trendRows: [],
    trendTotal: 0,
    insertResult: 1,
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("ensureNoteTemplate", () => {
  it("returns the org's active template without creating another", async () => {
    const t = await ensureNoteTemplate({ orgId: ORG });
    expect(t).toEqual({ id: TEMPLATE, name: "Palliative visit note", version: 1 });
    expect(ran("INSERT INTO note_template ")).toBe(false);
  });

  it("creates version 1 from the shipped default when the org has none", async () => {
    db.activeTemplate = null;
    const t = await ensureNoteTemplate({ orgId: ORG, userId: USER });
    expect(t.version).toBe(1);
    expect(t.id).toBe(TEMPLATE);

    const sections = calls.filter((c) => c.sql.includes("INSERT INTO note_template_section"));
    expect(sections).toHaveLength(DEFAULT_NOTE_SECTIONS.length);
    // sort_order follows the array, so the clinician sees the note in the order
    // the template declares rather than whatever order rows come back in.
    expect(sections.map((c) => c.values.at(-1))).toEqual(
      DEFAULT_NOTE_SECTIONS.map((_, i) => i),
    );
  });
});

describe("saveNoteTemplate", () => {
  const section = (o: Partial<TemplateSectionInput> = {}): TemplateSectionInput => ({
    sectionKey: "hpi", label: "History of present illness", helpText: null,
    kind: "prose", isRequired: true, notRequiredForVisitTypes: [], ...o,
  });

  it("writes a NEW version rather than editing the current one in place", async () => {
    // visit.note_template_id pins each visit to the version its note was
    // written under. Editing in place would silently restate what an already
    // attested note claimed its sections were.
    const r = await saveNoteTemplate({ orgId: ORG, userId: USER, sections: [section()] });
    expect(r.version).toBe(4);
    expect(ran("INSERT INTO note_template ")).toBe(true);
    expect(ran("UPDATE note_template_section")).toBe(false);
    expect(ran("DELETE FROM note_template_section")).toBe(false);
  });

  it("deactivates the old version before inserting the new one", async () => {
    // note_template_one_active_per_org is a unique partial index, so the
    // order matters: inserting first would violate it.
    await saveNoteTemplate({ orgId: ORG, sections: [section()] });
    const deactivate = calls.findIndex((c) => c.sql.includes("SET is_active = FALSE"));
    const insert = calls.findIndex((c) => c.sql.includes("INSERT INTO note_template "));
    expect(deactivate).toBeGreaterThanOrEqual(0);
    expect(deactivate).toBeLessThan(insert);
  });

  it("marks the new version as org-edited, not as the shipped default", async () => {
    await saveNoteTemplate({ orgId: ORG, sections: [section()] });
    expect(find("INSERT INTO note_template ")!.sql).toContain("'edited'");
  });

  it("stores sections in the order given", async () => {
    await saveNoteTemplate({
      orgId: ORG,
      sections: [section(), section({ sectionKey: "goals", label: "Goals" })],
    });
    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO note_template_section"));
    expect(inserts.map((c) => c.values.at(-1))).toEqual([0, 1]);
  });

  it("refuses an empty template", async () => {
    await expect(saveNoteTemplate({ orgId: ORG, sections: [] })).rejects.toThrow(
      /at least one section/i,
    );
    expect(ran("INSERT INTO note_template ")).toBe(false);
  });

  it("refuses a duplicate section key", async () => {
    // UNIQUE(template_id, section_key) would reject it anyway; failing here
    // names the offending key instead of surfacing a constraint violation.
    await expect(
      saveNoteTemplate({ orgId: ORG, sections: [section(), section()] }),
    ).rejects.toThrow(/appears more than once/i);
  });

  it("refuses a section key that is not a usable machine key", async () => {
    // section_key is what payer documentation rules and the audit packet match
    // on, so it cannot carry spaces or case.
    for (const bad of ["Past Medical History", "1_history", "hpi-2", ""]) {
      await expect(
        saveNoteTemplate({ orgId: ORG, sections: [section({ sectionKey: bad })] }),
      ).rejects.toThrow(/not a valid section key|at least one section/i);
    }
  });

  it("refuses a section with no label", async () => {
    await expect(
      saveNoteTemplate({ orgId: ORG, sections: [section({ label: "   " })] }),
    ).rejects.toThrow(/needs a label/i);
  });

  it("refuses a second vitals section", async () => {
    // Two vitals sections would give the sign guard two things to check
    // against one visit_vitals row.
    await expect(
      saveNoteTemplate({
        orgId: ORG,
        sections: [
          section({ sectionKey: "vitals", kind: "vitals" }),
          section({ sectionKey: "vitals_2", kind: "vitals" }),
        ],
      }),
    ).rejects.toThrow(/only one vitals section/i);
  });

  it("audits the edit, naming what became required", async () => {
    await saveNoteTemplate({
      orgId: ORG, userId: USER,
      sections: [section(), section({ sectionKey: "goals", label: "Goals", isRequired: false })],
    });
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.action).toBe("note_template_edit");
    expect(entry.targetType).toBe("note_template");
    expect(entry.payload).toMatchObject({
      sectionKeys: ["hpi", "goals"],
      requiredKeys: ["hpi"],
    });
  });

  it("carries visit-type exemptions onto the new version", async () => {
    await saveNoteTemplate({
      orgId: ORG,
      sections: [section({ notRequiredForVisitTypes: ["telehealth"] })],
    });
    expect(find("INSERT INTO note_template_section")!.values).toContainEqual(["telehealth"]);
  });
});

describe("getVisitNote", () => {
  beforeEach(() => {
    db.noteRows = [
      {
        section_key: "hpi", label: "History of present illness", help_text: null,
        kind: "prose", is_required: true, sort_order: 0,
        content: null, is_empty: null,
        carried_from_visit_id: null, carried_unchanged: null, updated_at: null,
      },
      {
        section_key: "vitals", label: "Vitals", help_text: null,
        kind: "vitals", is_required: false, sort_order: 1,
        content: null, is_empty: null,
        carried_from_visit_id: null, carried_unchanged: null, updated_at: null,
      },
    ];
  });

  it("returns a row for every template section, even ones never written", async () => {
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections.map((s) => s.sectionKey)).toEqual(["hpi", "vitals"]);
    expect(n.sections[0]!.isEmpty).toBe(true);
    expect(n.sections[0]!.carriedUnchanged).toBe(false);
  });

  it("lists required sections that are still empty", async () => {
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.missingRequired).toEqual([
      { sectionKey: "hpi", label: "History of present illness" },
    ]);
  });

  it("drops a required section on a visit type that cannot produce it", async () => {
    // Nobody takes a physical exam over video. Requiring it would make a
    // legitimate telehealth encounter unsignable.
    db.noteRows.push({
      section_key: "physical_exam", label: "Physical examination", help_text: null,
      kind: "prose", is_required: true, not_required_for_visit_types: ["telehealth"],
      sort_order: 2, content: null, is_empty: null,
      carried_from_visit_id: null, carried_unchanged: null, updated_at: null,
    });

    db.visit = { status: "in_progress", patient_id: PATIENT, visit_type: "new_patient_home" };
    let n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.missingRequired.map((m) => m.sectionKey)).toContain("physical_exam");

    calls = [];
    db.visit = { status: "in_progress", patient_id: PATIENT, visit_type: "telehealth" };
    n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.missingRequired.map((m) => m.sectionKey)).not.toContain("physical_exam");
  });

  it("reports the effective requiredness on the section itself", async () => {
    // The chip the clinician sees must be the same fact that blocks signing,
    // not the template's blanket flag.
    db.noteRows.push({
      section_key: "physical_exam", label: "Physical examination", help_text: null,
      kind: "prose", is_required: true, not_required_for_visit_types: ["telehealth"],
      sort_order: 2, content: null, is_empty: null,
      carried_from_visit_id: null, carried_unchanged: null, updated_at: null,
    });
    db.visit = { status: "in_progress", patient_id: PATIENT, visit_type: "telehealth" };
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections.find((s) => s.sectionKey === "physical_exam")!.isRequired).toBe(false);
  });

  it("gives a video visit on any type the telehealth exemptions (audit R22)", async () => {
    // Telehealth is the visit's own flag, not a type. A new patient seen over
    // video cannot be examined either, and the chip must say so — matching
    // what transitionVisit's guard will enforce at sign-off.
    db.noteRows.push({
      section_key: "physical_exam", label: "Physical examination", help_text: null,
      kind: "prose", is_required: true, not_required_for_visit_types: ["telehealth"],
      sort_order: 2, content: null, is_empty: null,
      carried_from_visit_id: null, carried_unchanged: null, updated_at: null,
    });
    db.visit = {
      status: "in_progress", patient_id: PATIENT, visit_type: "new_patient_home", is_telehealth: true,
    };
    let n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections.find((s) => s.sectionKey === "physical_exam")!.isRequired).toBe(false);
    expect(n.missingRequired.map((m) => m.sectionKey)).not.toContain("physical_exam");
    // HPI is not excepted for telehealth, so it is still owed.
    expect(n.missingRequired.map((m) => m.sectionKey)).toContain("hpi");

    // CONTROL — the same visit in person owes the exam.
    calls = [];
    db.visit = { ...db.visit, is_telehealth: false };
    n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.missingRequired.map((m) => m.sectionKey)).toContain("physical_exam");
  });

  it("drops a section from missingRequired once it holds text", async () => {
    db.noteRows[0]!.content = PROSE("Increasing dyspnoea over four days.");
    db.noteRows[0]!.is_empty = false;
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.missingRequired).toEqual([]);
  });

  it("judges the vitals section by visit_vitals, not by its own content", async () => {
    db.vitalsRow = { weight_kg: "61.4", recorded_at: new Date("2026-09-09T10:00:00Z") };
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections.find((s) => s.sectionKey === "vitals")!.isEmpty).toBe(false);
    expect(n.vitals!.weightKg).toBe(61.4);
  });

  it("treats a vitals row with every reading null as empty", async () => {
    // A row can exist with nothing on it — the form saved untouched. That is
    // not a recorded vital sign and must not satisfy the sign-off guard.
    db.vitalsRow = { weight_kg: null, bp_systolic: null, notes: null, recorded_at: new Date() };
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections.find((s) => s.sectionKey === "vitals")!.isEmpty).toBe(true);
  });

  it("does not let a vitals row holding only a note fill a required vitals section, as the sign guard does not", async () => {
    // The guard counts measurements only (num_nonnulls over the ten reading
    // columns). The editor also counted the free-text note, so "declined
    // weight" cleared the section here while the signature was still refused.
    db.visit = { status: "in_progress", patient_id: PATIENT, visit_type: "established_patient_home" };
    db.noteRows = [{
      section_key: "vitals", label: "Vitals", help_text: null, kind: "vitals",
      is_required: true, not_required_for_visit_types: [], sort_order: 0,
      content: null, is_empty: null,
      carried_from_visit_id: null, carried_unchanged: null, updated_at: null,
    }];
    db.vitalsRow = { weight_kg: null, notes: "Declined weight.", recorded_at: new Date() };

    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections[0]!.isEmpty).toBe(true);
    expect(n.missingRequired).toEqual([{ sectionKey: "vitals", label: "Vitals" }]);
    // The note is still written on the visit: returned, and still content.
    expect(n.vitals!.notes).toBe("Declined weight.");
    db.filledSectionCount = 0;
    expect(await noteHasContent({ orgId: ORG, visitId: VISIT })).toBe(true);

    // CONTROL: one measurement fills it, as one satisfies num_nonnulls.
    db.vitalsRow = { weight_kg: "61.4", notes: "Declined weight.", recorded_at: new Date() };
    const m = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(m.sections[0]!.isEmpty).toBe(false);
    expect(m.missingRequired).toEqual([]);
  });

  it("exposes updatedAt so the editor can re-key when the server's copy moves", async () => {
    // The stale-editor bug: TipTap builds its document once, so a section whose
    // content arrives after mount needs a key that moves with the server.
    const when = new Date("2026-09-09T12:00:00Z");
    db.noteRows[0]!.updated_at = when;
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections[0]!.updatedAt).toBe(when.toISOString());
  });

  it("surfaces carry-forward provenance to the reader", async () => {
    db.noteRows[0]!.carried_from_visit_id = PREV;
    db.noteRows[0]!.carried_unchanged = true;
    db.noteRows[0]!.is_empty = false;
    const n = await getVisitNote({ orgId: ORG, visitId: VISIT });
    expect(n.sections[0]!.carriedFromVisitId).toBe(PREV);
    expect(n.sections[0]!.carriedUnchanged).toBe(true);
  });
});

describe("saveNoteSection", () => {
  for (const status of ["documented", "pending_billing", "billed"]) {
    it(`refuses to write to a ${status} visit, and writes nothing`, async () => {
      db.visit = { status, patient_id: PATIENT };
      await expect(
        saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("x") }),
      ).rejects.toThrow(/signed and submitted/i);
      expect(ran("INSERT INTO visit_note_section")).toBe(false);
    });
  }

  it("allows a write while the visit is still in progress", async () => {
    const r = await saveNoteSection({
      orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("Dyspnoea."), userId: USER,
    });
    expect(r).toEqual({ updated: true, isEmpty: false });
  });

  it("rejects a section the org's template does not declare", async () => {
    db.sectionKind = null;
    await expect(
      saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "not_a_section", content: {} }),
    ).rejects.toThrow(/is not a section of this org's note template/i);
    expect(ran("INSERT INTO visit_note_section")).toBe(false);
  });

  it("refuses to write vitals through the section endpoint", async () => {
    // sectionContentIsEmpty always reports a vitals section empty, so letting
    // this through would store content the note read can never see.
    db.sectionKind = "vitals";
    await expect(
      saveNoteSection({
        orgId: ORG, visitId: VISIT, sectionKey: "vitals", content: { weightKg: 61 },
      }),
    ).rejects.toThrow(/vitals endpoint/i);
  });

  it("marks a blank document empty and real prose non-empty", async () => {
    const blank = await saveNoteSection({
      orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: BLANK_PROSE,
    });
    expect(blank.isEmpty).toBe(true);

    const written = await saveNoteSection({
      orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("Increasing dyspnoea."),
    });
    expect(written.isEmpty).toBe(false);
  });

  it("treats whitespace-only prose as empty", async () => {
    const r = await saveNoteSection({
      orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("   \n  "),
    });
    expect(r.isEmpty).toBe(true);
  });

  it("counts a list section by its items", async () => {
    db.sectionKind = "list";
    expect(
      (
        await saveNoteSection({
          orgId: ORG, visitId: VISIT, sectionKey: "medications", content: { items: [] },
        })
      ).isEmpty,
    ).toBe(true);
    expect(
      (
        await saveNoteSection({
          orgId: ORG, visitId: VISIT, sectionKey: "medications",
          content: { items: ["Morphine 2.5mg"] },
        })
      ).isEmpty,
    ).toBe(false);
  });

  it("clears carried_unchanged on write — an edited section is no longer copied text", async () => {
    await saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("x") });
    const upsert = find("INSERT INTO visit_note_section")!;
    expect(upsert.sql).toContain("carried_unchanged = FALSE");
    // Provenance is kept: where the text started is still true, and still
    // worth an auditor seeing.
    expect(upsert.sql).not.toContain("carried_from_visit_id = NULL");
  });

  it("moves a scheduled visit to in_progress on first write, leaving other statuses alone", async () => {
    // Both halves of the name, as the status that RESULTS: the fake applies
    // this UPDATE the way Postgres would. The second half is the reason the
    // CASE is there — a cancelled visit still takes a correction, and a bare
    // `SET status = 'in_progress'` would put it back on the round as one
    // somebody is mid-way through. Only the substring assertion used to stand
    // here, which says nothing about either.
    db.visit = { status: "scheduled", patient_id: PATIENT };
    await saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("x") });
    expect(db.visit!.status).toBe("in_progress");

    db.visit = { status: "cancelled", patient_id: PATIENT };
    await saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: PROSE("x") });
    expect(db.visit!.status).toBe("cancelled");

    const update = find("SET note_template_id")!;
    expect(update.sql).toContain("WHEN status = 'scheduled' THEN 'in_progress' ELSE status END");
  });

  it("404s a missing visit", async () => {
    db.visit = null;
    await expect(
      saveNoteSection({ orgId: ORG, visitId: VISIT, sectionKey: "hpi", content: {} }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("saveVitals", () => {
  it("refuses once the visit is signed", async () => {
    db.visit = { status: "documented", patient_id: PATIENT };
    await expect(
      saveVitals({ orgId: ORG, visitId: VISIT, vitals: { weightKg: 61 } }),
    ).rejects.toThrow(/signed and submitted/i);
    expect(ran("INSERT INTO visit_vitals")).toBe(false);
  });

  it("upserts one row per visit so a correction never double-counts the trend", async () => {
    await saveVitals({ orgId: ORG, visitId: VISIT, vitals: { weightKg: 61.4 }, userId: USER });
    const ins = find("INSERT INTO visit_vitals")!;
    expect(ins.sql).toContain("ON CONFLICT (visit_id) DO UPDATE");
    expect(ins.sql).toContain("recorded_at = now()");
  });

  it("moves a scheduled visit to in_progress and bumps updated_at, as typing a section does", async () => {
    // A nurse opens a SCHEDULED visit, types a weight into Vitals and tabs
    // out. The reading and the template pin were written while the visit
    // stayed under "Scheduled" on /visits with an updated_at from the day it
    // was booked — the round's own screen saying nobody had been. Its three
    // sibling writers (saveNoteSection, carryForwardSections, documentVisit)
    // have always carried this bump.
    db.visit = { status: "scheduled", patient_id: PATIENT };
    await saveVitals({ orgId: ORG, visitId: VISIT, vitals: { weightKg: 61.4 }, userId: USER });
    // The consequence first, for the same reason as its carry-forward sibling
    // below: a dropped bump should read "expected 'scheduled' to be
    // 'in_progress'", not as a missing substring.
    expect(db.visit!.status).toBe("in_progress");
    const update = find("SET note_template_id")!;
    expect(update.sql).toContain("WHEN status = 'scheduled' THEN 'in_progress' ELSE status END");
    expect(update.sql).toContain("updated_at = now()");
  });

  it("never moves a visit that is already past scheduled", async () => {
    // The CASE is the whole guard, and "not scheduled" is not only
    // in_progress: a CANCELLED visit still takes a correction — only the three
    // signed statuses are refused outright above — so an unguarded
    // `SET status = 'in_progress'` would quietly put a cancelled visit back on
    // the round as one somebody is mid-way through.
    //
    // The fake applies this UPDATE rather than recording it, so the assertion
    // is the status that results, not a substring of the statement.
    db.visit = { status: "cancelled", patient_id: PATIENT };
    await saveVitals({ orgId: ORG, visitId: VISIT, vitals: { weightKg: 61.4 } });
    expect(ran("SET note_template_id")).toBe(true);
    expect(db.visit!.status).toBe("cancelled");
  });

  it("denormalises patient_id from the visit rather than trusting a caller", async () => {
    await saveVitals({ orgId: ORG, visitId: VISIT, vitals: { weightKg: 61.4 } });
    expect(find("INSERT INTO visit_vitals")!.values).toContain(PATIENT);
  });

  it("audits which readings were recorded, never their values", async () => {
    await saveVitals({
      orgId: ORG, visitId: VISIT, userId: USER,
      vitals: { weightKg: 61.4, painScore: 3, bpSystolic: null },
    });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.action).toBe("visit_vitals_record");
    expect(entry.payload).toEqual({ fields: ["weightKg", "painScore"] });
  });

  it("404s a missing visit", async () => {
    db.visit = null;
    await expect(saveVitals({ orgId: ORG, visitId: VISIT, vitals: {} })).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("getCarryForwardSource", () => {
  it("returns null when the patient has no earlier signed visit", async () => {
    db.prevVisit = null;
    expect(await getCarryForwardSource({ orgId: ORG, visitId: VISIT })).toBeNull();
  });

  it("only considers signed visits as a source", async () => {
    // Carrying a half-written paragraph forward would propagate work nobody
    // attested to.
    db.prevVisit = { id: PREV, dos: new Date(), label: "Established patient — home" };
    await getCarryForwardSource({ orgId: ORG, visitId: VISIT });
    expect(find("FROM visit cur")!.sql).toContain("'documented', 'pending_billing', 'billed'");
  });

  it("never offers the current visit as its own source", async () => {
    db.prevVisit = { id: PREV, dos: new Date(), label: null };
    await getCarryForwardSource({ orgId: ORG, visitId: VISIT });
    expect(find("FROM visit cur")!.sql).toContain("p.id <> cur.id");
  });

  it("only looks backwards in time, not merely at the last signed visit", async () => {
    // Palliative notes are often written up days late. Ordering by signed_at
    // alone would offer to carry a LATER encounter's findings backwards into
    // an earlier note — a note describing a state the patient had not reached
    // yet is precisely the documentation failure this feature must not create.
    db.prevVisit = { id: PREV, dos: new Date(), label: null };
    await getCarryForwardSource({ orgId: ORG, visitId: VISIT });
    expect(find("FROM visit cur")!.sql).toMatch(
      /COALESCE\(p\.start_time, p\.scheduled_start\)\s*<\s*COALESCE\(cur\.start_time, cur\.scheduled_start, now\(\)\)/,
    );
  });

  it("offers only non-empty sections", async () => {
    db.prevVisit = { id: PREV, dos: new Date("2026-09-01"), label: "Established patient — home" };
    db.prevSections = [{ section_key: "hpi", label: "History of present illness" }];
    const s = await getCarryForwardSource({ orgId: ORG, visitId: VISIT });
    expect(s!.sections).toEqual([{ sectionKey: "hpi", label: "History of present illness" }]);
    expect(find("JOIN note_template_section t")!.sql).toContain("NOT s.is_empty");
  });

  it("reports the source date as an ISO string", async () => {
    db.prevVisit = { id: PREV, dos: new Date("2026-09-01T14:00:00Z"), label: null };
    const s = await getCarryForwardSource({ orgId: ORG, visitId: VISIT });
    expect(s!.visitDate).toBe("2026-09-01T14:00:00.000Z");
  });
});

describe("carryForwardSections", () => {
  it("refuses once this visit is signed", async () => {
    db.visit = { status: "billed", patient_id: PATIENT };
    await expect(
      carryForwardSections({ orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"] }),
    ).rejects.toThrow(/signed/i);
    expect(ran("INSERT INTO visit_note_section")).toBe(false);
  });

  it("refuses a source that is not a signed visit for the same patient", async () => {
    // Without this, carry-forward is a route to copy one patient's history
    // onto another patient's note.
    db.sourceVisitValid = false;
    await expect(
      carryForwardSections({ orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"] }),
    ).rejects.toThrow(/not a signed visit for this patient/i);
    expect(ran("INSERT INTO visit_note_section")).toBe(false);
  });

  it("scopes the source check to this visit's patient", async () => {
    await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"],
    });
    const src = find("AND patient_id =")!;
    expect(src.values).toContain(PATIENT);
    expect(src.sql).toContain("'documented', 'pending_billing', 'billed'");
  });

  it("never overwrites a section already written on this visit", async () => {
    // A substring, because this file's fake answers the INSERT with a row
    // count instead of applying it. The BEHAVIOUR — the clinician's own
    // paragraph surviving a carry-forward of the same key — is proved in
    // note-template-pin.spec.ts, whose fake holds the rows and runs this
    // ON CONFLICT ... WHERE itself. If this line goes red, read that failure
    // first: it names what the patient's note lost.
    await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"], userId: USER,
    });
    expect(find("INSERT INTO visit_note_section")!.sql).toContain(
      "WHERE visit_note_section.is_empty",
    );
  });

  it("copies nothing from an empty source section", async () => {
    await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"],
    });
    expect(find("INSERT INTO visit_note_section")!.sql).toContain("AND NOT s.is_empty");
  });

  it("marks what it copies as carried and unedited", async () => {
    await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"],
    });
    const ins = find("INSERT INTO visit_note_section")!;
    expect(ins.sql).toContain("carried_from_visit_id");
    expect(ins.sql).toContain("carried_unchanged = TRUE");
    expect(ins.values).toContain(PREV);
  });

  it("reports which keys copied", async () => {
    const r = await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi", "assessment_and_plan"],
    });
    expect(r).toEqual({ copied: ["hpi", "assessment_and_plan"], skipped: [] });
  });

  it("reports keys the database declined to write as skipped, not copied", async () => {
    db.insertResult = 0; // the target section was not empty, or the source was
    const r = await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi", "assessment_and_plan"],
    });
    expect(r).toEqual({ copied: [], skipped: ["hpi", "assessment_and_plan"] });
  });

  it("moves a scheduled visit to in_progress and bumps updated_at, as typing a section does", async () => {
    // Carry-forward is the one write that starts a NOTE without starting the
    // VISIT if this bump is missing: a clinician opens a scheduled visit,
    // brings last week's history forward and closes it, and /visits still
    // files it under "Scheduled" with an updated_at from the day it was
    // booked — the screen the round is worked from saying nobody has been.
    // Its two sibling writers (saveNoteSection, saveVitals) are pinned for
    // this above; this one was not.
    db.visit = { status: "scheduled", patient_id: PATIENT };
    await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"], userId: USER,
    });
    // The consequence first, so a developer who drops the bump reads
    // "expected 'scheduled' to be 'in_progress'" — the visit still filed under
    // Scheduled — rather than a missing substring. The fake applies this
    // UPDATE, so that assertion is the state that results.
    expect(db.visit!.status).toBe("in_progress");
    const update = find("UPDATE visit")!;
    expect(update.sql).toContain("WHEN status = 'scheduled' THEN 'in_progress' ELSE status END");
    expect(update.sql).toContain("updated_at = now()");
  });

  it("never moves a visit that is already past scheduled", async () => {
    // The CASE is the whole guard, and "not scheduled" is not only
    // in_progress: a cancelled visit still takes a correction — only the three
    // signed statuses are refused outright above — so an unguarded
    // `SET status = 'in_progress'` would quietly put a cancelled visit back on
    // the round as one somebody is mid-way through.
    //
    // The fake applies this UPDATE rather than recording it, so the assertion
    // is the status that results, not a substring of the statement.
    db.visit = { status: "cancelled", patient_id: PATIENT };
    await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"],
    });
    expect(ran("UPDATE visit")).toBe(true);
    expect(db.visit!.status).toBe("cancelled");
  });

  it("records the provenance in the audit log", async () => {
    await carryForwardSections({
      orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"], userId: USER,
    });
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.action).toBe("visit_note_carry_forward");
    expect(entry.payload).toEqual({ fromVisitId: PREV, copied: ["hpi"], skipped: [] });
  });

  it("404s a missing visit", async () => {
    db.visit = null;
    await expect(
      carryForwardSections({ orgId: ORG, visitId: VISIT, fromVisitId: PREV, sectionKeys: ["hpi"] }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("noteHasContent", () => {
  it("is true when any section is filled", async () => {
    db.filledSectionCount = 1;
    expect(await noteHasContent({ orgId: ORG, visitId: VISIT })).toBe(true);
    // Cheap check first — no need to read vitals once a section answers it.
    expect(ran("FROM visit_vitals WHERE visit_id")).toBe(false);
  });

  it("is true when only a vital sign was recorded", async () => {
    db.filledSectionCount = 0;
    db.vitalsRow = { weight_kg: "61.4", recorded_at: new Date() };
    expect(await noteHasContent({ orgId: ORG, visitId: VISIT })).toBe(true);
  });

  it("is false when the note and the vitals are both empty", async () => {
    db.filledSectionCount = 0;
    db.vitalsRow = null;
    expect(await noteHasContent({ orgId: ORG, visitId: VISIT })).toBe(false);
  });

  it("is false when a vitals row exists with nothing on it", async () => {
    db.filledSectionCount = 0;
    db.vitalsRow = { weight_kg: null, notes: "   ", recorded_at: new Date() };
    expect(await noteHasContent({ orgId: ORG, visitId: VISIT })).toBe(false);
  });
});

describe("getVitalsTrend", () => {
  it("maps numeric columns and carries the visit id", async () => {
    db.trendRows = [
      {
        visit_id: VISIT, weight_kg: "61.4", pps_percent: 60, pain_score: 3,
        recorded_at: new Date("2026-09-11T22:40:00Z"),
        // A DATE, as Prisma returns one: UTC midnight of the day.
        dos_day: new Date("2026-09-09T00:00:00Z"),
      },
    ];
    const t = await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    expect(t.rows[0]!.weightKg).toBe(61.4);
    expect(t.rows[0]!.ppsPercent).toBe(60);
    expect(t.rows[0]!.painScore).toBe(3);
    expect(t.rows[0]!.visitId).toBe(VISIT);
    expect(t.rows[0]!.recordedAt).toBe("2026-09-11T22:40:00.000Z");
  });

  it("carries the date of service separately from the data-entry time", async () => {
    // These differ whenever a visit is written up later, which in palliative
    // care is most of them.
    db.trendRows = [
      {
        visit_id: VISIT, weight_kg: "61.4",
        recorded_at: new Date("2026-09-11T22:40:00Z"),
        dos_day: new Date("2026-09-09T00:00:00Z"),
      },
    ];
    const t = await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    expect(t.rows[0]!.dateOfService).toBe("2026-09-09");
    expect(t.rows[0]!.recordedAt).toBe("2026-09-11T22:40:00.000Z");
  });

  /**
   * The date is the practice's day (0107). It was the instant, and the chart
   * sliced its UTC day: Shirley Tanaka's 8:30 pm Ohio visit on 22 Sep showed
   * as 23 Sep on localhost. Which day an instant falls on is Postgres's
   * answer here (AT TIME ZONE), so this pins that the statement asks it in
   * the org's own zone; the day itself is checked on localhost.
   */
  it("works the day out in the org's own zone, and reads this org's rows only", async () => {
    await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    const page = find("WHERE vv.patient_id =")!;
    expect(page.sql).toMatch(
      /\(COALESCE\(v\.start_time, v\.scheduled_start, vv\.recorded_at\) AT TIME ZONE o\.timezone\)::date\s+AS dos_day/,
    );
    expect(page.sql).toContain("JOIN org o ON o.id = vv.org_id");
    expect(page.sql).toContain("JOIN visit v ON v.id = vv.visit_id AND v.org_id = vv.org_id");
    expect(page.sql).toContain("AND vv.org_id =");
    expect(page.values).toContain(ORG);
    expect(find("COUNT(*)::bigint AS n")!.values).toContain(ORG);
  });

  it("CONTROL: a row with no day carries none, rather than a guessed one", async () => {
    db.trendRows = [{ visit_id: VISIT, weight_kg: "61.4", dos_day: null }];
    const t = await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    expect(t.rows[0]!.dateOfService).toBeNull();
  });

  it("orders newest first by date of service, not by when it was typed", async () => {
    await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    const sql = find("WHERE vv.patient_id =")!.sql;
    expect(sql).toContain(
      "ORDER BY COALESCE(v.start_time, v.scheduled_start, vv.recorded_at) DESC",
    );
    expect(sql).not.toContain("ORDER BY recorded_at DESC");
  });

  it("defaults to 50 rows and caps a caller's request at 200", async () => {
    await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    expect(find("WHERE vv.patient_id =")!.values).toContain(50);
    calls = [];
    await getVitalsTrend({ orgId: ORG, patientId: PATIENT, limit: 9999 });
    expect(find("WHERE vv.patient_id =")!.values).toContain(200);
  });

  it("reports how many readings the patient HAS, not how many it returned", async () => {
    // The cap is deliberate; presenting the page as the whole record was not.
    // Newest-first means the rows it drops are the OLDEST — the baseline a
    // palliative weight loss is measured from ("160 pounds to a current
    // 128"). Without a true total the screen has no way to say so.
    db.trendRows = [
      { visit_id: VISIT, weight_kg: "58.06", dos_day: new Date("2026-09-09T00:00:00Z") },
    ];
    db.trendTotal = 61;
    const t = await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    expect(t.rows).toHaveLength(1);
    expect(t.total).toBe(61);
  });

  it("counts over the same rows the page is drawn from", async () => {
    // A total counted more widely than the list would be a fresh untruth in
    // place of the old one: a vitals row whose visit is gone is not a visit
    // with recorded vitals.
    await getVitalsTrend({ orgId: ORG, patientId: PATIENT });
    const count = find("COUNT(*)::bigint AS n")!;
    expect(count.sql).toContain("FROM visit_vitals vv");
    expect(count.sql).toContain("JOIN visit v ON v.id = vv.visit_id");
    expect(count.values).toContain(PATIENT);
    // Unfiltered by the page's LIMIT, or it would only ever count the page.
    expect(count.sql).not.toContain("LIMIT");
  });
});

describe("hasAnyReading", () => {
  it("is false for a row of nulls", () => {
    expect(hasAnyReading(EMPTY_VITALS)).toBe(false);
  });

  it("is true for a single reading, including a zero", () => {
    // A pain score of 0 is a recorded observation, not a missing one.
    expect(hasAnyReading({ ...EMPTY_VITALS, painScore: 0 })).toBe(true);
  });

  it("counts free-text notes but not whitespace", () => {
    expect(hasAnyReading({ ...EMPTY_VITALS, notes: "Declined weight." })).toBe(true);
    expect(hasAnyReading({ ...EMPTY_VITALS, notes: "   " })).toBe(false);
  });
});

describe("hasAnyMeasurement", () => {
  it("counts a measurement, including zero, and never the free-text note", () => {
    // The narrower of the two rules: what fills a required vitals section,
    // matching the sign guard's num_nonnulls over the same ten columns.
    expect(hasAnyMeasurement({ ...EMPTY_VITALS, painScore: 0 })).toBe(true);
    expect(hasAnyMeasurement({ ...EMPTY_VITALS, notes: "Declined weight." })).toBe(false);
    expect(hasAnyMeasurement(EMPTY_VITALS)).toBe(false);
  });
});
