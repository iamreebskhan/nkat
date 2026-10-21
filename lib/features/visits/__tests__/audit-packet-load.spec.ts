/**
 * The audit packet loader — what it reads before reconcile() compares anything.
 *
 * Two defects found live on one visit, both of which put a false statement in
 * front of a clinician on screen AND an auditor in the PDF:
 *
 * 1. NULL template pin. load() selected sections WHERE template_id = the
 *    visit's pinned note_template_id. The pin is the version a note is written
 *    under — the visit's own, else the org's active template — and every write
 *    that starts a note sets it: saving a section, carry-forward, recording
 *    vitals, and sign-off. Back then only a direct section save did, so
 *    carry-forward left it NULL. Joining on a NULL pin matched no rows, so a
 *    visit documented by carry-forward was reported as "the signed note
 *    contains no documentation at all" — seen on a visit with four written
 *    sections. Same fix as the sign guard: fall back to the org's active
 *    template.
 *
 * 2. Vitals always "not documented". A vitals section's content lives in
 *    visit_vitals, never in its own visit_note_section row, so the join always
 *    reported it empty — "Not documented: Vitals" beside the vitals table the
 *    same PDF prints. Now judged by the readings, as getVisitNote does.
 *
 * lib/db is mocked with a fake tx. The fake models ROWS IN TABLES and runs the
 * loader's own statements over them through the pocket SQL evaluator at the
 * foot of this file. It used to answer "FROM note_template_section t" with a
 * canned array, so the section join was never evaluated and none of these
 * assertions could see what it does:
 *
 *   - deleting `s.visit_id = ¶::uuid AND` from the LEFT JOIN left this whole
 *     file green, while on the live database that same visit matched 326
 *     section rows from 44 OTHER visits — one patient's note text under
 *     another patient's heading, in the preview, the reconciliation and the
 *     auditor's PDF;
 *   - COALESCE(s.is_empty, TRUE) and COALESCE(s.carried_unchanged, FALSE) are
 *     reached only by a template section the visit never wrote, which a canned
 *     row cannot be, so flipping either default — telling an auditor an empty
 *     note is fully documented, or that untouched sections were cloned from an
 *     earlier visit — changed nothing here either;
 *   - ORDER BY t.sort_order could be dropped and the note still "read" right,
 *     because the canned array was already in order.
 *
 * Nothing below restates those rules. The tables hold rows — including a decoy
 * visit in the same org, pinned to the same template version, carrying the
 * same section keys — and the statement under test decides which ones come
 * back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  setContent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
// No browser and no PHI log row: the packet's HTML is what is under test.
vi.mock("puppeteer", () => ({ default: { launch: h.launch } }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({
  logPhiExport: vi.fn().mockResolvedValue(undefined),
  logPhiAccess: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";

import {
  generateAuditPacketPdf,
  getNotePreviewHtml,
  getVisitReconciliation,
} from "../audit-packet.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
/** Another visit of this org, same template, same section keys, other patient. */
const DECOY = "e0000000-0000-4000-8000-0000000000de";
/** The version this visit's note was started under. */
const PINNED_TEMPLATE = "71000000-0000-4000-8000-000000000001";
/** The version the org has moved on to since. */
const ACTIVE_TEMPLATE = "72000000-0000-4000-8000-000000000002";
/** Another agency on the same database, and the version IT is writing under. */
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_TEMPLATE = "73000000-0000-4000-8000-000000000003";
const AUTHOR = "d0000000-0000-4000-8000-000000000001";

let calls: { sql: string; values: unknown[] }[] = [];
let tables: SqlTables;
let vitalsRow: Record<string, unknown> | null;
/** The payer documentation check's reads (audit R19); null = no row. */
let docFacts: Record<string, unknown> | null = null;
let docReqs: unknown[] = [];
/** The care-team header's reads (audit R30), and the patient's primary NP. */
let headerProviders: unknown[] = [];
let headerContacts: unknown[] = [];
let palliativeName: string | null = null;
/** What this visit's row stores beyond visitRow — its units (0106) among it. */
let visitStored: Record<string, unknown> = {};
/** The visit's bill as stored; null = no bill yet. */
let billRow: Record<string, unknown> | null = null;
/** The org row; the packet dates the visit in its timezone. */
let orgRow: { id: string; name: string; timezone: string };

const visitRow = {
  id: VISIT, status: "pending_billing", dos: new Date("2026-09-09T10:00:00Z"),
  total_minutes: 45, acp_minutes: 0, is_telehealth: false, telehealth_modality: null,
  cpt_codes_assigned: ["99349"], icd10_codes: [], modifiers: [], signed_at: new Date(),
  visit_type_label: "Established patient — home",
  signer_name: null, signer_email: null, clinician_name: null,
};
const patientRow = {
  id: "f0000000-0000-4000-8000-000000000001",
  first_name: "Stephen", last_name: "Singleton", date_of_birth: new Date("1936-01-19"),
  primary_member_id: "M-777",
};
const NO_READINGS = {
  weight_kg: null, height_cm: null, bp_systolic: null, bp_diastolic: null, heart_rate: null,
  resp_rate: null, temperature_c: null, spo2_percent: null, pps_percent: null, pain_score: null,
  recorded_at: new Date("2026-09-09T10:00:00Z"),
};

const PROSE = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/**
 * A section the template declares. `order` is the sort_order the admin gave
 * it; rows are pushed in whatever order the fixture writes them, the way a
 * table hands rows back, so ORDER BY has something to do.
 */
function declare(
  templateId: string,
  section: { key: string; label: string; kind?: string; order: number },
) {
  tables.note_template_section.push({
    org_id: ORG, template_id: templateId, section_key: section.key, label: section.label,
    kind: section.kind ?? "prose", sort_order: section.order,
  });
}

/** A visit_note_section row, as a save or a carry-forward would leave it. */
function write(
  visitId: string,
  key: string,
  row: { text?: string | null; isEmpty?: boolean; carried?: boolean } = {},
) {
  tables.visit_note_section.push({
    org_id: ORG, visit_id: visitId, section_key: key,
    content: row.text == null ? null : PROSE(row.text),
    is_empty: row.isEmpty ?? row.text == null,
    carried_unchanged: row.carried ?? false,
  });
}

/** The two prose sections most of these tests judge the note by. */
function twoProseSections(templateId = PINNED_TEMPLATE) {
  declare(templateId, { key: "hpi", label: "History of present illness", order: 0 });
  declare(templateId, { key: "physical_exam", label: "Physical examination", order: 1 });
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    // The statement as the database would see it, binds numbered in place.
    const statement = strings.reduce((acc, part, i) => `${acc}$${i - 1}${part}`);
    // The care-team header's two reads (audit R30).
    if (sql.includes("FROM patient_external_provider")) return Promise.resolve(headerProviders);
    if (sql.includes("FROM patient_contact")) return Promise.resolve(headerContacts);
    // The payer documentation check's two reads (audit R19).
    if (sql.includes("FROM visit dv")) return Promise.resolve(docFacts ? [docFacts] : []);
    if (sql.includes("FROM documentation_requirement")) return Promise.resolve(docReqs);
    // The patient query also reads FROM visit v, so it is matched first.
    if (sql.includes("JOIN patient pt")) {
      return Promise.resolve([{ ...patientRow, palliative_provider_name: palliativeName }]);
    }
    // The visit's own row is canned apart from its status, which the table
    // below owns so the statements and the findings cannot disagree about it.
    // Its units come back only if the statement selects them, as in Postgres.
    if (sql.includes("FROM visit v")) {
      const row: Record<string, unknown> = { ...visitRow, ...visitStored, status: tables.visit[0]!.status };
      if (!sql.includes("v.cpt_units")) delete row.cpt_units;
      return Promise.resolve([row]);
    }
    // The visit's bill, likewise with its units only if selected.
    if (sql.includes("FROM superbill s")) {
      if (!billRow) return Promise.resolve([]);
      const row = { ...billRow };
      if (!sql.includes("s.cpt_units")) delete row.cpt_units;
      return Promise.resolve([row]);
    }
    // The two statements whose own predicates decide what comes back: the
    // section join (visit scoping, the COALESCE defaults, the template
    // resolution and sort order) and the addenda read (visit scoping and the
    // order an auditor reads corrections in).
    if (sql.includes("FROM visit_addendum") || sql.includes("FROM note_template_section t")) {
      return Promise.resolve(runSql(statement, values, tables));
    }
    if (sql.includes("FROM visit_vitals")) return Promise.resolve(vitalsRow ? [vitalsRow] : []);
    // The org row, with only the columns the statement selects.
    const orgRead = /SELECT ([\w, ]+) FROM org WHERE id = ¶::uuid/.exec(sql);
    if (orgRead) {
      if (values[0] !== orgRow.id) return Promise.resolve([]);
      const cols = orgRead[1]!.split(",").map((c) => c.trim());
      return Promise.resolve([
        Object.fromEntries(cols.map((c) => {
          if (!(c in orgRow)) throw new Error(`org has no column ${c}`);
          return [c, orgRow[c as keyof typeof orgRow]];
        })),
      ]);
    }
    return Promise.resolve([]); // branding
  };
  return { $queryRaw: run, $executeRaw: run };
}

const sectionQuery = () => calls.find((c) => c.sql.includes("FROM note_template_section t"))!;
const noteContent = async () =>
  (await getVisitReconciliation({ orgId: ORG, visitId: VISIT })).findings.find(
    (f) => f.label === "Note content",
  )!;
const finding = async (label: string) =>
  (await getVisitReconciliation({ orgId: ORG, visitId: VISIT })).findings.find(
    (f) => f.label === label,
  );
const preview = async () => (await getNotePreviewHtml({ orgId: ORG, visitId: VISIT })).html;

beforeEach(() => {
  calls = [];
  vitalsRow = null;
  docFacts = null;
  docReqs = [];
  headerProviders = [];
  headerContacts = [];
  palliativeName = null;
  visitStored = {};
  billRow = null;
  orgRow = { id: ORG, name: "Design Partner", timezone: "America/New_York" };
  tables = {
    // This visit is pinned to v1; the decoy is another of the org's visits,
    // signed, pinned to the same version — the rows the join must not reach.
    visit: [
      { id: VISIT, org_id: ORG, status: visitRow.status, note_template_id: PINNED_TEMPLATE },
      { id: DECOY, org_id: ORG, status: "documented", note_template_id: PINNED_TEMPLATE },
    ],
    note_template: [
      // Another agency's active version, FIRST in the table: `LIMIT 1` with no
      // ORDER BY takes whichever row comes back first, so a fallback that
      // stopped filtering by org reaches this one. Nothing here enforces RLS,
      // which is what a connection that bypasses it — the preview
      // deployment's — sees.
      { id: OTHER_ORG_TEMPLATE, org_id: OTHER_ORG, is_active: true },
      { id: PINNED_TEMPLATE, org_id: ORG, is_active: false },
      { id: ACTIVE_TEMPLATE, org_id: ORG, is_active: true },
    ],
    note_template_section: [
      // What that widened fallback would hand back: a heading no note of this
      // org was ever written under.
      {
        org_id: OTHER_ORG, template_id: OTHER_ORG_TEMPLATE, section_key: "chaplain_visit",
        label: "OTHER ORG: Chaplain visit", kind: "prose", sort_order: 0,
      },
    ],
    visit_note_section: [],
    visit_addendum: [],
    app_user: [{ id: AUTHOR, full_name: "Test Admin" }],
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("audit packet loader — template pin", () => {
  it("reads the sections of the version this visit's note was started under", async () => {
    // The pin beats the active version, which is the whole point of pinning:
    // an attested note is judged by the sections it was written under. If the
    // COALESCE ever resolved the other way round, the auditor's copy would
    // report a section the note never had as missing, and hide one it does.
    twoProseSections(PINNED_TEMPLATE);
    declare(ACTIVE_TEMPLATE, { key: "spiritual_assessment", label: "Spiritual assessment", order: 0 });
    write(VISIT, "hpi", { text: "Breathless climbing the stairs." });

    const note = await noteContent();
    expect(note.detail).toBe("1 of 2 sections documented. Not documented: Physical examination.");
    expect(note.detail).not.toContain("Spiritual assessment");
  });

  it("falls back to the org's active template when the visit has no pin", async () => {
    // The live incident: a note documented entirely by carry-forward left the
    // pin NULL, the join matched nothing, and a visit with four written
    // sections was reported as containing no documentation at all.
    tables.visit[0]!.note_template_id = null;
    twoProseSections(PINNED_TEMPLATE);
    declare(ACTIVE_TEMPLATE, { key: "spiritual_assessment", label: "Spiritual assessment", order: 0 });
    write(VISIT, "spiritual_assessment", { text: "Finds meaning in faith." });

    expect((await noteContent()).detail).toBe("1 of 1 sections documented.");

    const { sql, values } = sectionQuery();
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain("SELECT note_template_id FROM visit WHERE id =");
    expect(sql).toMatch(/FROM note_template nt\s+WHERE nt\.org_id = ¶::uuid AND nt\.is_active/);
    expect(values).toContain(ORG);
  });

  it("falls back to THIS org's active template, never another agency's", async () => {
    // The org half of that fallback — `nt.org_id = ¶::uuid` — used to be held
    // up by the regex above and nothing else: every template row in this file
    // belonged to one org, so there was no foreign active version for a
    // widened lookup to reach and deleting the predicate stayed green here.
    // There is one now, and widened, this note is judged against the OTHER
    // agency's sections: the packet reports "The signed note contains no
    // documentation at all" — the very incident the fallback was added for —
    // over a note that has everything its own template asks for.
    tables.visit[0]!.note_template_id = null;
    declare(ACTIVE_TEMPLATE, { key: "spiritual_assessment", label: "Spiritual assessment", order: 0 });
    write(VISIT, "spiritual_assessment", { text: "Finds meaning in faith." });

    expect((await noteContent()).detail).toBe("1 of 1 sections documented.");
    const html = await preview();
    expect(html).toContain("<h2>Spiritual assessment</h2>");
    expect(html).toContain("Finds meaning in faith.");
    expect(html).not.toContain("OTHER ORG");
  });

  it("resolves the pin from the visit and the org alone, wherever the visit has got to", async () => {
    // The resolution asks which VERSION the note is written under; the visit's
    // progress is a different fact and must not narrow the lookup. This
    // reconciliation deliberately runs before signing as well as after, and
    // the packet, the note editor and the sign guard all have to agree about
    // the version or the clinician is told one thing on screen and the auditor
    // another.
    //
    // No pinned visit can be back at 'scheduled' today — the three writers
    // that set the pin each move a scheduled visit to in_progress in the same
    // UPDATE — but that invariant lives in three separate statements, and a
    // status predicate creeping into this subquery would fall through to the
    // ACTIVE template and judge an attested note by a version it was never
    // written under.
    twoProseSections(PINNED_TEMPLATE);
    declare(ACTIVE_TEMPLATE, { key: "spiritual_assessment", label: "Spiritual assessment", order: 0 });
    write(VISIT, "hpi", { text: "Breathless climbing the stairs." });

    for (const status of ["scheduled", "in_progress", "documented", "cancelled"]) {
      tables.visit[0]!.status = status;
      expect({ status, note: (await noteContent()).detail }).toEqual({
        status,
        note: "1 of 2 sections documented. Not documented: Physical examination.",
      });
    }
  });

  it("no longer joins on the bare pin, which matched nothing when it was NULL", async () => {
    await getVisitReconciliation({ orgId: ORG, visitId: VISIT });
    expect(sectionQuery().sql).not.toMatch(
      /WHERE t\.template_id = \(SELECT note_template_id FROM visit WHERE id = ¶::uuid\)\s*\n\s*ORDER BY/,
    );
  });

  it("reports sections found through the fallback as documentation", async () => {
    tables.visit[0]!.note_template_id = null;
    twoProseSections(ACTIVE_TEMPLATE);
    write(VISIT, "hpi", { text: "Breathless climbing the stairs." });
    const note = await noteContent();
    expect(note.severity).toBe("match");
    expect(note.detail).toBe("1 of 2 sections documented. Not documented: Physical examination.");
  });
});

describe("audit packet loader — the section join is scoped to this visit", () => {
  // The clause under test is `ON s.visit_id = ¶::uuid AND s.section_key =
  // t.section_key`. Without the first half, every section key of this visit's
  // template joins to every row with that key in the org: on the live database
  // one visit matched 326 rows from 44 other visits. What follows is a note
  // written on THIS visit and another patient's note text sitting under the
  // same keys on another visit of the same org.
  beforeEach(() => {
    twoProseSections(PINNED_TEMPLATE);
    write(VISIT, "hpi", { text: "Breathless climbing the stairs." });
    write(DECOY, "hpi", { text: "OTHER PATIENT: chest pain since Tuesday." });
    write(DECOY, "physical_exam", { text: "OTHER PATIENT: chest clear, no oedema." });
  });

  it("counts only this visit's own sections as documentation", async () => {
    // Unscoped, both of the decoy's rows join in and the auditor is told 3 of
    // 3 sections are documented on a note with one paragraph in it.
    expect((await noteContent()).detail).toBe(
      "1 of 2 sections documented. Not documented: Physical examination.",
    );
  });

  it("never prints another visit's note text in the preview", async () => {
    const html = await preview();
    expect(html).toContain("Breathless climbing the stairs.");
    expect(html).not.toContain("OTHER PATIENT");
    // Unscoped, the key joins to two rows and the preview prints the heading
    // twice, the second time over the other patient's paragraph.
    expect(html.match(/<h2>History of present illness<\/h2>/g)).toHaveLength(1);
    // Nothing was written here under this heading, so the preview shows none
    // of it — unscoped, the decoy's paragraph arrives under it.
    expect(html).not.toContain("Physical examination");
  });

  it("keeps the predicate that does it in the statement", async () => {
    // Belt and braces beside the behaviour above: the exact clause, so a
    // reader of this spec can see what is being defended. This is a
    // readability pin, not the guard — the two tests above are — so a benign
    // rewrite that reorders this ON clause trips it while the note stays
    // right. Check them first before changing the statement back.
    await getVisitReconciliation({ orgId: ORG, visitId: VISIT });
    expect(sectionQuery().sql).toContain(
      "ON s.visit_id = ¶::uuid AND s.section_key = t.section_key",
    );
  });
});

describe("audit packet loader — a section the visit never wrote", () => {
  // COALESCE(s.is_empty, TRUE) and COALESCE(s.carried_unchanged, FALSE) exist
  // only for the LEFT JOIN miss: both columns are NOT NULL in the table, so
  // the defaults are reached exactly when a template section has no row on
  // this visit — which is the common case (574 missing against 326 present
  // section slots across the local fixture's visits).
  beforeEach(() => {
    twoProseSections(PINNED_TEMPLATE);
    write(VISIT, "hpi", { text: "Breathless climbing the stairs." });
  });

  it("reports a section with no row at all as not documented", async () => {
    // With the default flipped, every section the visit never wrote counts as
    // filled: the auditor's PDF loses its "Not documented" list entirely and
    // reports an eight-line note as fifteen of fifteen sections documented.
    expect((await noteContent()).detail).toBe(
      "1 of 2 sections documented. Not documented: Physical examination.",
    );
    // And there is nothing of it to print: a section with no row has no
    // content either, whatever the emptiness flag is made to say.
    expect(await preview()).not.toContain("Physical examination");
  });

  it("does not report a section with no row as carried forward unchanged", async () => {
    // "Carried forward unchanged" is the packet's cloned-note flag. With the
    // other default flipped, every unwritten section appears under it —
    // accusing the clinician of cloning sections they never wrote.
    expect(await finding("Carried forward unchanged")).toBeUndefined();
    expect(await preview()).not.toContain("carried forward, unedited");
  });

  it("flags only the sections actually carried forward", async () => {
    // CONTROL for the two above: the flag does appear when a row says so, so
    // the assertions are reading the column and not a permanently empty list.
    write(VISIT, "physical_exam", { text: "Chest clear.", carried: true });
    const flag = await finding("Carried forward unchanged");
    expect(flag!.detail).toContain("Physical examination was brought forward");
    expect(flag!.detail).not.toContain("History of present illness");
  });
});

describe("audit packet loader — the order an auditor reads the note in", () => {
  it("prints sections in the template's order, not the order rows come back in", async () => {
    // A note whose assessment is printed above the history reads as a
    // different document; ORDER BY t.sort_order is the only thing imposing the
    // order the admin arranged the template in. These rows are pushed in the
    // opposite order on purpose.
    declare(PINNED_TEMPLATE, { key: "assessment_and_plan", label: "Assessment and plan", order: 2 });
    declare(PINNED_TEMPLATE, { key: "hpi", label: "History of present illness", order: 0 });
    write(VISIT, "hpi", { text: "Breathless climbing the stairs." });
    write(VISIT, "assessment_and_plan", { text: "Continue current regimen." });

    const html = await preview();
    expect(html.indexOf("History of present illness")).toBeLessThan(
      html.indexOf("Assessment and plan"),
    );
  });

  it("prints addenda in the order they were signed, not the order they were recorded", async () => {
    // Corrections read as a sequence: an addendum that answers an earlier one
    // printed above it misstates the record. The later correction is pushed
    // first and carries the lower id, so neither the row order nor the id
    // order gives the right answer.
    tables.visit_addendum.push(
      {
        id: "aa000000-0000-4000-8000-000000000001", org_id: ORG, visit_id: VISIT, author_user_id: AUTHOR,
        body: "Second: daughter confirmed the dose change.", author_credential: "NP",
        signed_at: new Date("2026-09-13T09:00:00Z"),
      },
      {
        id: "aa000000-0000-4000-8000-000000000002", org_id: ORG, visit_id: VISIT, author_user_id: AUTHOR,
        body: "First: late entry, daughter present.", author_credential: "NP",
        signed_at: new Date("2026-09-12T10:00:00Z"),
      },
      {
        id: "aa000000-0000-4000-8000-000000000003", org_id: ORG, visit_id: DECOY, author_user_id: AUTHOR,
        body: "OTHER PATIENT: correction to the plan.", author_credential: "NP",
        signed_at: new Date("2026-09-11T10:00:00Z"),
      },
    );

    const html = await preview();
    expect(html.indexOf("First: late entry")).toBeLessThan(html.indexOf("Second: daughter"));
    expect(html).not.toContain("OTHER PATIENT");
  });
});

describe("audit packet loader — vitals section", () => {
  // A vitals section never has its own visit_note_section row — its content
  // lives in visit_vitals — so the join hands it back on the COALESCE default
  // and the loader judges it by the readings.
  beforeEach(() => {
    declare(PINNED_TEMPLATE, { key: "hpi", label: "History of present illness", order: 0 });
    declare(PINNED_TEMPLATE, { key: "vitals", label: "Vitals", kind: "vitals", order: 1 });
    write(VISIT, "hpi", { text: "Breathless climbing the stairs." });
  });

  it("counts vitals as documented when a reading was recorded", async () => {
    // 000c live: 128 lb and PPS 50 recorded, yet the packet said
    // "Not documented: Vitals".
    vitalsRow = { ...NO_READINGS, weight_kg: "58.06", pps_percent: 50 };
    const note = await noteContent();
    expect(note.detail).toBe("2 of 2 sections documented.");
    expect(note.detail).not.toContain("Vitals");
  });

  it("counts a single reading, including a zero, as documented", async () => {
    // A pain score of 0 is an observation, not a missing one.
    vitalsRow = { ...NO_READINGS, pain_score: 0 };
    expect((await noteContent()).detail).toBe("2 of 2 sections documented.");
  });

  it("still reports vitals missing when the row holds no reading", async () => {
    // A row saved untouched is not a recorded vital sign.
    vitalsRow = { ...NO_READINGS };
    expect((await noteContent()).detail).toBe("1 of 2 sections documented. Not documented: Vitals.");
  });

  it("still reports vitals missing when no row exists at all", async () => {
    vitalsRow = null;
    expect((await noteContent()).detail).toBe("1 of 2 sections documented. Not documented: Vitals.");
  });

  it("leaves every non-vitals section's own emptiness untouched", async () => {
    // A prose section opened and saved without typing anything: the row is
    // there and says is_empty, which is not the same question as the vitals
    // rule above.
    tables.visit_note_section = [];
    write(VISIT, "hpi", { isEmpty: true });
    vitalsRow = { ...NO_READINGS, weight_kg: "58.06" };
    expect((await noteContent()).detail).toBe(
      "1 of 2 sections documented. Not documented: History of present illness.",
    );
  });
});

describe("note preview — self-identifying (audit R32), with its addenda (audit R15)", () => {
  it("carries the member ID, the addenda and who attested it", async () => {
    tables.visit_addendum.push({
      id: "aa000000-0000-4000-8000-000000000001", org_id: ORG, visit_id: VISIT, author_user_id: AUTHOR,
      body: "Late entry: daughter present.", author_credential: "NP",
      signed_at: new Date("2026-09-12T10:00:00Z"),
    });
    const html = await preview();
    expect(html).toContain("<dt>Member ID</dt><dd>M-777</dd>");
    expect(html).toContain("Late entry: daughter present.");
    // The author's name is read through the join, not stored on the addendum.
    expect(html).toContain("Test Admin, NP");
    expect(html).toContain("Electronically signed by");
  });

  it("puts the addenda in the reconciliation too", async () => {
    tables.visit_addendum.push({
      id: "aa000000-0000-4000-8000-000000000001", org_id: ORG, visit_id: VISIT, author_user_id: null,
      body: "x", author_credential: null, signed_at: new Date("2026-09-12T10:00:00Z"),
    });
    const r = await getVisitReconciliation({ orgId: ORG, visitId: VISIT });
    expect(r.findings.find((f) => f.label === "Addenda")?.severity).toBe("attention");
  });
});

describe("payer documentation (audit R19)", () => {
  const PAYER = "a0000000-0000-4000-8000-000000000302";
  const facts = {
    is_telehealth: false, telehealth_modality: null, total_minutes: 45, dx_count: 1,
    dos: new Date("2026-09-09T00:00:00Z"), state: "OH", payer_id: PAYER,
    payer_name: "UnitedHealthcare Community Plan Ohio", codes: ["99349"],
    filled_keys: ["hpi", "physical_exam", "assessment_and_plan"],
    template_keys: ["chief_complaint", "hpi", "vitals", "physical_exam", "assessment_and_plan"],
    has_vitals: true,
  };
  const uhc = [
    {
      code: "99349",
      required_chart_elements: ["vitals", "chief_complaint", "physical_exam", "diagnosis", "plan", "telehealth_modality"],
    },
  ];
  const payerFindings = async () =>
    (await getVisitReconciliation({ orgId: ORG, visitId: VISIT })).findings.filter(
      (f) => f.label === "Payer documentation",
    );

  it("names what the payer requires and the signed note lacks", async () => {
    docFacts = facts;
    docReqs = uhc;
    const [f, ...rest] = await payerFindings();
    expect(rest).toEqual([]);
    // visitRow is pending_billing: a signed note, so a discrepancy.
    expect(f!.severity).toBe("mismatch");
    expect(f!.detail).toContain("UnitedHealthcare Community Plan Ohio requires, for 99349");
    expect(f!.detail).toContain("Not documented in the signed note: Chief complaint.");
  });

  it("asks for the requirement by the visit's payer, state and date of service", async () => {
    docFacts = facts;
    docReqs = uhc;
    await payerFindings();
    expect(calls.find((c) => c.sql.includes("FROM visit dv"))!.values).toContain(VISIT);
    const q = calls.find((c) => c.sql.includes("FROM documentation_requirement"))!;
    expect(q.values).toContain(PAYER);
    expect(q.values).toContain("OH");
    expect(q.values).toContain("2026-09-09");
    expect(q.values).toContainEqual(["99349"]);
  });

  it("says nothing when the patient has no payer", async () => {
    docFacts = { ...facts, payer_id: null };
    docReqs = uhc;
    expect(await payerFindings()).toEqual([]);
    expect(calls.some((c) => c.sql.includes("FROM documentation_requirement"))).toBe(false);
  });

  it("says nothing when the payer publishes no structured standard", async () => {
    docFacts = facts;
    docReqs = [];
    expect(await payerFindings()).toEqual([]);
  });
});

/**
 * Units on the note and on the bill (0106). reconcile compares them, so both
 * reads have to name cpt_units: with the visit's dropped, every add-on bill
 * that matches its note is reported as "Procedure codes differ"; with both
 * dropped, a G0318 × 2 bill against a × 3 note reads as agreement. This fake
 * used to carry no units and answer no bill, so neither read was checked.
 */
describe("audit packet loader — units on the note and on the bill", () => {
  const procedure = async () =>
    (await getVisitReconciliation({ orgId: ORG, visitId: VISIT })).findings.find((f) =>
      f.label.startsWith("Procedure codes"),
    )!;

  beforeEach(() => {
    visitStored = { cpt_codes_assigned: ["99350", "G0318"], icd10_codes: ["C34.90"], cpt_units: { G0318: 3 } };
    billRow = {
      id: "b0000000-0000-4000-8000-000000000001", status: "draft",
      cpt_codes: ["99350", "G0318"], cpt_units: { G0318: 3 }, icd10_codes: ["C34.90"], modifiers: [],
      billed_amount_cents: BigInt(14834 + 3 * 2497), provider_npi: "1234567893", provider_name: "Jane NP",
      billing_npi: "1497758544", place_of_service_code: "12", member_id_snapshot: "M-777",
      payer_name: "Medicare",
    };
  });

  it("CONTROL: a bill carrying the note's G0318 × 3 agrees with it, and says × 3", async () => {
    const f = await procedure();
    expect(f.label).toBe("Procedure codes agree");
    expect(f.detail).toContain("99350, G0318 ×3");
  });

  it("CONTROL: a bill at × 2 against a note at × 3 is reported, naming both", async () => {
    billRow = { ...billRow, cpt_units: { G0318: 2 } };
    const f = await procedure();
    expect(f.label).toBe("Procedure codes differ");
    expect(f.detail).toContain("The bill carries 99350, G0318 ×2");
    expect(f.detail).toContain("the signed visit records 99350, G0318 ×3");
  });
});

describe("care-team header (audit R30)", () => {
  // The header of Mark's note names the palliative provider, the PCP, the
  // referrer and the specialists. None of it reached the preview or the packet.
  it("prints the outside providers, read for the visit's patient", async () => {
    headerProviders = [
      { role: "primary_care", role_label: null, full_name: "Dr Alan Brooks", npi: "1234567893", phone: null },
    ];
    const html = await preview();
    expect(html).toContain("<dt>Primary care provider</dt><dd>Dr Alan Brooks (NPI 1234567893)");
    expect(html).toContain("<dt>Referring physician</dt><dd>—</dd>");
    expect(calls.find((c) => c.sql.includes("FROM patient_external_provider"))!.values).toEqual([patientRow.id, ORG]);
    // Only the two family roles the header prints are read.
    expect(calls.find((c) => c.sql.includes("FROM patient_contact"))!.sql).toContain(
      "is_healthcare_poa OR is_primary_caregiver",
    );
  });

  it("heads the block with the patient's primary NP", async () => {
    palliativeName = "Test Admin";
    const html = await preview();
    expect(html).toContain("<dt>Palliative care provider</dt><dd>Test Admin</dd>");
    expect(calls.find((c) => c.sql.includes("JOIN patient pt"))!.sql).toContain("pt.primary_np_user_id");
  });

  it("escapes a provider's name", async () => {
    headerProviders = [
      { role: "specialist", role_label: "Pulmonologist", full_name: "Dr <b>Nair</b>", npi: null, phone: null },
    ];
    const html = await preview();
    expect(html).toContain("<dt>Pulmonologist</dt><dd>Dr &lt;b&gt;Nair&lt;/b&gt;</dd>");
    expect(html).not.toContain("<b>Nair</b>");
  });

  it("names the healthcare POA and the primary caregiver, with a phone when there is one", async () => {
    headerContacts = [
      { full_name: "Tom Reyes", phone: null, is_healthcare_poa: true, is_primary_caregiver: false },
      { full_name: "Mary Singleton", phone: "614-555-0142", is_healthcare_poa: false, is_primary_caregiver: true },
    ];
    const html = await preview();
    expect(html).toContain("<dt>Healthcare POA</dt><dd>Tom Reyes</dd>");
    expect(html).toContain("<dt>Primary caregiver</dt><dd>Mary Singleton · 614-555-0142</dd>");
  });
});

/**
 * The preview and the packet date the visit on the practice's day. They
 * printed the visit start's UTC day, so a visit from 8 pm Eastern on read as
 * the next day: on the note a clinician previews and on the auditor's copy,
 * beside a bill carrying another date.
 */
describe("dates on the preview and the packet are the practice's days", () => {
  /** 8:30 pm EDT on 9 Sep, which is already the 10th in UTC. */
  const EVENING = new Date("2026-09-10T00:30:00Z");

  /** The HTML generateAuditPacketPdf hands the browser. */
  const packetHtml = async () => {
    await generateAuditPacketPdf({ orgId: ORG, userId: AUTHOR, visitId: VISIT });
    return h.setContent.mock.calls.at(-1)![0] as string;
  };

  beforeEach(() => {
    h.setContent.mockReset().mockResolvedValue(undefined);
    h.launch.mockResolvedValue({
      connected: true,
      newPage: async () => ({
        setContent: h.setContent,
        pdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        close: async () => undefined,
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("CONTROL: the note preview dates an 8:30 pm EDT visit on the 9th", async () => {
    visitStored = { dos: EVENING };
    expect(await preview()).toContain("<dt>Date of visit</dt><dd>2026-09-09</dd>");
  });

  it("CONTROL: the practice's own zone decides", async () => {
    // 10:30 pm PDT on 9 Sep: already the 10th in New York.
    orgRow = { ...orgRow, timezone: "America/Los_Angeles" };
    visitStored = { dos: new Date("2026-09-10T05:30:00Z") };
    expect(await preview()).toContain("<dt>Date of visit</dt><dd>2026-09-09</dd>");
  });

  it("twin: a daytime visit keeps its day", async () => {
    // visitRow's own dos, 10:00Z: 6 am EDT on the 9th. Passes before and after.
    expect(await preview()).toContain("<dt>Date of visit</dt><dd>2026-09-09</dd>");
  });

  it("CONTROL: the auditor's packet gives the same date of service", async () => {
    visitStored = { dos: EVENING };
    expect(await packetHtml()).toContain("<div>Date of service <strong>2026-09-09</strong></div>");
  });

  it("CONTROL: the packet's date of service is the practice's own zone's too", async () => {
    // 10:30 pm PDT on 9 Sep: already the 10th in New York.
    orgRow = { ...orgRow, timezone: "America/Los_Angeles" };
    visitStored = { dos: new Date("2026-09-10T05:30:00Z") };
    expect(await packetHtml()).toContain("<div>Date of service <strong>2026-09-09</strong></div>");
  });

  it("CONTROL: an addendum signed at 9 pm EDT on the 13th is 'the latest on 2026-09-13'", async () => {
    tables.visit_addendum.push({
      id: "aa000000-0000-4000-8000-000000000001", org_id: ORG, visit_id: VISIT, author_user_id: AUTHOR,
      body: "Late entry.", author_credential: "NP", signed_at: new Date("2026-09-14T01:00:00Z"),
    });
    const addenda = await finding("Addenda");
    expect(addenda!.detail).toContain("the latest on 2026-09-13");
  });

  it("CONTROL: in Los Angeles, an addendum signed at 10 pm PDT on the 13th is 'the latest on 2026-09-13'", async () => {
    // 05:00Z on the 14th: already 1 am on the 14th in New York.
    orgRow = { ...orgRow, timezone: "America/Los_Angeles" };
    tables.visit_addendum.push({
      id: "aa000000-0000-4000-8000-000000000001", org_id: ORG, visit_id: VISIT, author_user_id: AUTHOR,
      body: "Late entry.", author_credential: "NP", signed_at: new Date("2026-09-14T05:00:00Z"),
    });
    expect((await finding("Addenda"))!.detail).toContain("the latest on 2026-09-13");
  });

  it("CONTROL: the care-team caption's export date is the practice's today", async () => {
    headerProviders = [
      { role: "primary_care", role_label: null, full_name: "Dr Alan Brooks", npi: "1234567893", phone: null },
    ];
    // 10 pm EDT on 22 Sep; UTC is already on the 23rd.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T02:00:00Z"));
    expect(await packetHtml()).toContain("as on file at export (2026-09-22)");
  });

  it("CONTROL: in Los Angeles the export date is its own today", async () => {
    orgRow = { ...orgRow, timezone: "America/Los_Angeles" };
    headerProviders = [
      { role: "primary_care", role_label: null, full_name: "Dr Alan Brooks", npi: "1234567893", phone: null },
    ];
    // 10 pm PDT on 22 Sep; New York is already on the 23rd.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T05:00:00Z"));
    expect(await packetHtml()).toContain("as on file at export (2026-09-22)");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * A pocket SQL evaluator.
 *
 * Enough of SELECT to run the loader's own statements over the tables above:
 * FROM, LEFT/INNER JOIN with a real ON predicate, WHERE, scalar subqueries,
 * COALESCE, ORDER BY and LIMIT. It knows nothing about visits, sections or
 * pins — it evaluates whatever the statement says, so a predicate deleted from
 * the service changes what these tests see, which is the entire point. An
 * unrecognised statement throws rather than quietly answering.
 * ──────────────────────────────────────────────────────────────────────────── */

type SqlRow = Record<string, unknown>;
type SqlTables = Record<string, SqlRow[]>;
type SqlScope = Record<string, SqlRow | null>;
interface SqlCtx {
  scope: SqlScope;
  binds: unknown[];
  tables: SqlTables;
}
type SqlExpr = (c: SqlCtx) => unknown;
type SqlQuery = (c: SqlCtx) => SqlRow[];

/** Words that can never be a column alias, so `x AS` may be left implicit. */
const SQL_WORDS = new Set([
  "AND", "AS", "ASC", "BY", "CASE", "DESC", "ELSE", "END", "FROM", "GROUP", "IN", "INNER", "IS",
  "JOIN", "LEFT", "LIMIT", "NOT", "NULL", "ON", "OR", "ORDER", "OUTER", "SELECT", "THEN", "TRUE",
  "FALSE", "WHEN", "WHERE",
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
    if ("(),.=<>*+-/".includes(c)) { out.push(c); i++; continue; }
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

/** ORDER BY ... ASC, NULLS LAST — the Postgres default. */
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
    if (!(owner in c.scope)) throw new Error(`sql: nothing named "${owner}" is in scope`);
    const row = c.scope[owner];
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
    const order: SqlExpr[] = [];
    if (this.eat("ORDER")) {
      this.expect("BY");
      do {
        order.push(this.expr());
        this.eat("ASC");
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
          for (const key of order) {
            const d = sqlOrderBy(key({ ...c, scope: a }), key({ ...c, scope: b }));
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
    // A cast changes no row this fake holds.
    while (this.peek() === "::") { this.i += 2; }
    return e;
  }

  end(): void {
    if (this.i < this.t.length) {
      throw new Error(`sql: unread tail at "${this.t.slice(this.i, this.i + 6).join(" ")}"`);
    }
  }
}

/** Run one statement, with `$0`-numbered binds, over the modelled tables. */
function runSql(sql: string, binds: unknown[], tables: SqlTables): SqlRow[] {
  const parser = new SqlParser(sqlTokens(sql));
  const query = parser.select();
  parser.end();
  return query({ scope: {}, binds, tables });
}
