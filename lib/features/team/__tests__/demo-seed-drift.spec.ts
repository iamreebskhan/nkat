/**
 * The demo tenant seed (audit R20) against the code it copies.
 *
 * db/seed/tenant-demo-palliative.sql is SQL, so nothing type-checks it
 * against the app. A permission added to a role, a renamed note section or a
 * new default visit type would leave the demo tenant quietly behind the
 * product: seeded staff missing what their role now grants, notes written
 * under a key no template declares, a visit booked as a type the org does not
 * have. This reads the file as text and holds it to the TypeScript it copies.
 *
 * The database-level checks (duplicate patient names and birth dates, visits
 * over a clinician's daily capacity) are the seed's own closing DO block,
 * which CI runs on every push.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// visit-types and visit-services are service modules; only their constants
// are read here.
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn(),
  changedFieldNames: vi.fn(),
}));

import { CONTACT_RELATIONSHIPS } from "@/lib/features/patients/contacts.types";
import { estimateRateCents } from "@/lib/features/superbills/superbill-pure";
import {
  DEFAULT_NOTE_SECTIONS,
  DEFAULT_SECTION_KEYS,
  DEFAULT_TEMPLATE_NAME,
} from "@/lib/features/visits/note-template";
import { DEFAULT_VISIT_SERVICES } from "@/lib/features/visits/visit-services.service";
import { DEFAULT_VISIT_TYPES } from "@/lib/features/visits/visit-types.service";

import { ROLE_DEFAULT_PERMISSIONS, ROLE_TEMPLATES, type RoleTemplate } from "../team.types";

const SEED = readFileSync(
  fileURLToPath(new URL("../../../../db/seed/tenant-demo-palliative.sql", import.meta.url)),
  "utf8",
);

// ---- reading the SQL ----------------------------------------------------

/** The SQL with `--` comments removed; string literals left intact. */
function stripComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          inString = false;
        }
      }
    } else if (ch === "'") {
      inString = true;
      out += ch;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
    } else {
      out += ch;
    }
  }
  return out;
}

/** One parenthesised tuple starting at `start`, split on its top-level commas. */
function readTuple(text: string, start: number): { values: string[]; end: number } {
  const values: string[] = [];
  let depth = 0;
  let current = "";
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
      if (depth > 1) current += ch;
    } else if (ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) {
        values.push(current.trim());
        return { values, end: i + 1 };
      }
      current += ch;
    } else if (ch === "," && depth === 1) {
      values.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  throw new Error(`unterminated tuple at ${start}`);
}

/** Every row of every `INSERT INTO <table> (cols) VALUES (...), ...` in the SQL, as raw tokens. */
function insertedRows(sql: string, table: string): Record<string, string>[] {
  const text = stripComments(sql);
  const rows: Record<string, string>[] = [];
  for (const m of text.matchAll(new RegExp(`INSERT INTO\\s+${table}\\s*\\(([^)]*)\\)\\s*VALUES`, "gi"))) {
    const cols = m[1]!.split(",").map((c) => c.trim());
    let i = m.index! + m[0].length;
    for (;;) {
      while (/\s/.test(text[i] ?? "")) i++;
      if (text[i] !== "(") break;
      const { values, end } = readTuple(text, i);
      rows.push(Object.fromEntries(cols.map((c, k) => [c, values[k] ?? ""])));
      i = end;
      while (/\s/.test(text[i] ?? "")) i++;
      if (text[i] !== ",") break;
      i++;
    }
  }
  return rows;
}

/** A SQL string literal's value; null for NULL. */
function str(raw: string | undefined): string | null {
  if (raw === undefined || /^NULL$/i.test(raw)) return null;
  const m = /^'((?:[^']|'')*)'$/.exec(raw);
  if (!m) throw new Error(`not a string literal: ${raw}`);
  return m[1]!.replace(/''/g, "'");
}

/** The strings in an ARRAY['a', 'b'] literal (none for NULL). */
function strArray(raw: string | undefined): string[] {
  return [...(raw ?? "").matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

// ---- the checks, as functions so each control can run them on a broken copy ----

/** The '-- role:<template>' blocks: the template each names, the one it inserts, and what it grants. */
function roleBlocks(sql: string) {
  return [...sql.matchAll(/^-- role:([a-z_]+)[ \t]*\r?\n([\s\S]*?;)/gm)].map((m) => ({
    marker: m[1]!,
    inserts: /SELECT\s+'([a-z_]+)'/.exec(m[2]!)?.[1] ?? null,
    permissions: strArray(/ARRAY\[([\s\S]*?)\]/.exec(m[2]!)?.[1]),
  }));
}

/** Where the seeded permission sets differ from ROLE_DEFAULT_PERMISSIONS; empty when they match. */
function permissionDrift(sql: string): string[] {
  const problems: string[] = [];
  const blocks = roleBlocks(sql);
  for (const b of blocks) {
    if (b.inserts !== b.marker) problems.push(`role:${b.marker} block inserts '${b.inserts}'`);
    if (!(ROLE_TEMPLATES as readonly string[]).includes(b.marker)) {
      problems.push(`role:${b.marker} is not a role template`);
      continue;
    }
    const want = ROLE_DEFAULT_PERMISSIONS[b.marker as RoleTemplate];
    const got = b.permissions;
    if (new Set(got).size !== got.length) problems.push(`role:${b.marker} lists a permission twice`);
    const missing = want.filter((p) => !got.includes(p));
    const extra = got.filter((p) => !want.includes(p));
    if (missing.length > 0) problems.push(`role:${b.marker} is missing ${missing.join(", ")}`);
    if (extra.length > 0) problems.push(`role:${b.marker} grants ${extra.join(", ")} beyond the template`);
  }
  const held = new Set(insertedRows(sql, "demo_seed_user").map((r) => str(r.role_template)));
  for (const t of held) {
    if (!blocks.some((b) => b.marker === t)) problems.push(`seeded staff hold ${t}, which has no role block`);
  }
  return problems;
}

/** Section keys and kinds the seed writes that the default template would not accept. */
function sectionDrift(sql: string): string[] {
  const rows = insertedRows(sql, "demo_seed_section").map((r) => ({
    key: str(r.section_key)!,
    kind: str(r.kind)!,
  }));
  const problems: string[] = [];
  if (rows.length === 0) problems.push("the seed writes no note sections");
  for (const r of rows) {
    const def = DEFAULT_NOTE_SECTIONS.find((s) => s.sectionKey === r.key);
    if (!DEFAULT_SECTION_KEYS.includes(r.key) || !def) {
      problems.push(`section ${r.key} is not in DEFAULT_SECTION_KEYS`);
    } else if (def.kind === "vitals") {
      problems.push(`${r.key} is a vitals section: vitals live in visit_vitals, not in a section row`);
    } else if (def.kind !== r.kind) {
      problems.push(`${r.key} is written as ${r.kind}; the template declares ${def.kind}`);
    }
  }
  // Vitals are satisfied by the visit_vitals row, which the seed's own
  // closing check requires on every signed home visit.
  for (const s of DEFAULT_NOTE_SECTIONS) {
    if (s.isRequired && s.kind !== "vitals" && !rows.some((r) => r.key === s.sectionKey)) {
      problems.push(`required section ${s.sectionKey} is never written`);
    }
  }
  return problems;
}

/** Visit types the seed books visits under without creating them for the org. */
function visitTypeDrift(sql: string): string[] {
  const created = new Set(insertedRows(sql, "org_visit_type").map((r) => str(r.slug)));
  const used = new Set(insertedRows(sql, "demo_seed_visit").map((r) => str(r.visit_type)));
  return [...used]
    .filter((t) => !created.has(t))
    .map((t) => `visits are booked as ${t}, which the seed never creates for the org`);
}

/** The statement starting at `start` in comment-stripped SQL, through its closing semicolon. */
function statementAt(text: string, start: number): string {
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    // A doubled '' toggles twice, so it stays inside the string.
    if (ch === "'") inString = !inString;
    else if (ch === ";" && !inString) return text.slice(start, i + 1);
  }
  throw new Error(`unterminated statement at ${start}`);
}

/** The seed's `INSERT INTO <table> (...) ...;`, comments stripped; null when it has none. */
function insertStatement(sql: string, table: string): string | null {
  const text = stripComments(sql);
  const m = new RegExp(`INSERT INTO\\s+${table}\\s*\\(`, "i").exec(text);
  return m ? statementAt(text, m.index) : null;
}

/** An INSERT statement's column list. */
function insertColumns(stmt: string): string[] {
  return (/\(([^)]*)\)/.exec(stmt)?.[1] ?? "").split(",").map((c) => c.trim());
}

// The patient columns 0103 retired (audit R30): kept for rollback, never written.
const RETIRED_PATIENT_COLUMNS = [
  "emergency_contact_name",
  "emergency_contact_phone",
  "referring_physician_name",
  "referring_physician_npi",
];

/** Retired columns the seed still writes: listed in an INSERT INTO patient, or SET by an UPDATE of patient or its ON CONFLICT. */
function retiredColumnWrites(sql: string): string[] {
  const text = stripComments(sql);
  const written = new Set<string>();
  for (const m of text.matchAll(/INSERT INTO\s+patient\s*\(|UPDATE\s+patient\b/gi)) {
    const stmt = statementAt(text, m.index!);
    const cols = /^INSERT/i.test(stmt) ? insertColumns(stmt) : [];
    const sets = /\bSET\b([\s\S]*)$/i.exec(stmt)?.[1] ?? "";
    for (const c of RETIRED_PATIENT_COLUMNS) {
      if (cols.includes(c) || new RegExp(`\\b${c}\\s*=`).test(sets)) written.add(c);
    }
  }
  return [...written];
}

/**
 * Where the seed's writes into 0103's tables would leave the demo tenant
 * behind the app: an insert missing, a re-run adding a second copy, an NPI
 * written, or a contact saved as 'other' or as a relationship the table
 * refuses when its brackets say who they are.
 */
function circleDrift(sql: string): string[] {
  const problems: string[] = [];
  // Each insert's NOT EXISTS guard, and the column it matches on.
  const guards: [string, string][] = [
    ["patient_contact", "full_name"],
    ["external_provider", "full_name"],
    ["patient_external_provider", "role"],
  ];
  for (const [table, key] of guards) {
    const stmt = insertStatement(sql, table);
    if (!stmt) {
      problems.push(`the seed writes no ${table}`);
      continue;
    }
    const guard = new RegExp(`NOT EXISTS\\s*\\(\\s*SELECT 1 FROM ${table}\\s+\\w+\\s+WHERE[^()]*\\b${key}\\b`);
    if (!guard.test(stmt)) {
      problems.push(`the ${table} insert has no NOT EXISTS guard on ${key}, so a re-run adds a second copy`);
    }
  }
  const provider = insertStatement(sql, "external_provider");
  if (provider && insertColumns(provider).includes("npi")) problems.push("the external_provider insert writes an NPI");
  const link = insertStatement(sql, "patient_external_provider");
  if (link && !/'referring'/.test(link)) problems.push("no patient is linked to a referring physician");

  const contact = insertStatement(sql, "patient_contact");
  if (contact) {
    for (const c of ["phone", "is_emergency_contact"]) {
      if (!insertColumns(contact).includes(c)) problems.push(`the patient_contact insert does not write ${c}`);
    }
    // The seed's CASE from the word in each contact's brackets to a relationship.
    const saidAs = new Map([...contact.matchAll(/WHEN '([^']*)'\s+THEN '([^']*)'/g)].map((m) => [m[1]!, m[2]!]));
    for (const [said, rel] of saidAs) {
      if (!(CONTACT_RELATIONSHIPS as readonly string[]).includes(rel)) {
        problems.push(`'${said}' is saved as ${rel}, which patient_contact does not accept`);
      }
    }
    const patients = insertedRows(sql, "demo_seed_patient");
    if (patients.length === 0) problems.push("no demo patients found to check");
    for (const row of patients) {
      const name = str(row.emergency_contact_name)!;
      const said = /\(([^)]*)\)\s*$/.exec(name)?.[1]?.toLowerCase();
      if (!said || !saidAs.has(said)) problems.push(`${name} would be saved as 'other'`);
    }
  }
  return problems;
}

/** The seeded note template's sections, in the fields ensureNoteTemplate writes. */
function templateRows(sql: string) {
  return insertedRows(sql, "demo_seed_template_section").map((r) => ({
    sectionKey: str(r.section_key)!,
    label: str(r.label),
    helpText: str(r.help_text),
    kind: str(r.kind),
    isRequired: String(r.is_required).toUpperCase() === "TRUE",
    notRequiredForVisitTypes: strArray(r.not_required_for_visit_types),
    sortOrder: Number(r.sort_order),
  }));
}

/**
 * Where the seeded note template differs from the one ensureNoteTemplate
 * creates from DEFAULT_NOTE_SECTIONS; empty when it matches. A section the
 * template does not declare never renders, and one declared with a different
 * rule blocks or passes a signature differently from a real org.
 */
function templateDrift(sql: string): string[] {
  const rows = templateRows(sql);
  const problems: string[] = [];
  const want = DEFAULT_NOTE_SECTIONS.map((s, i) => ({
    sectionKey: s.sectionKey,
    label: s.label,
    helpText: s.helpText ?? null,
    kind: s.kind,
    isRequired: s.isRequired,
    notRequiredForVisitTypes: s.notRequiredForVisitTypes ?? [],
    sortOrder: i,
  }));
  for (const w of want) {
    const n = rows.filter((r) => r.sectionKey === w.sectionKey).length;
    if (n === 0) problems.push(`template section ${w.sectionKey} is missing`);
    if (n > 1) problems.push(`template section ${w.sectionKey} is listed ${n} times`);
  }
  const fields = ["label", "helpText", "kind", "isRequired", "notRequiredForVisitTypes", "sortOrder"] as const;
  for (const r of rows) {
    const w = want.find((x) => x.sectionKey === r.sectionKey);
    if (!w) {
      problems.push(`template section ${r.sectionKey} is not in DEFAULT_NOTE_SECTIONS`);
      continue;
    }
    for (const f of fields) {
      if (JSON.stringify(r[f]) !== JSON.stringify(w[f])) {
        problems.push(
          `template section ${r.sectionKey}: ${f} is ${JSON.stringify(r[f])}, DEFAULT_NOTE_SECTIONS says ${JSON.stringify(w[f])}`,
        );
      }
    }
  }
  const declared = new Set(rows.map((r) => r.sectionKey));
  for (const r of insertedRows(sql, "demo_seed_section")) {
    const key = str(r.section_key)!;
    if (!declared.has(key)) problems.push(`notes are written under ${key}, which the seeded template does not declare`);
  }
  return problems;
}

/**
 * Where the template's writes would go wrong on a first run or a re-run: a
 * second active template (note_template_one_active_per_org refuses it and the
 * seed aborts), a second copy of a section, default sections written into
 * the org's own later version, or seeded notes left pinned to nothing.
 */
function templateWriteDrift(sql: string): string[] {
  const text = stripComments(sql);
  const problems: string[] = [];
  const notesAt = text.search(/INSERT INTO\s+visit_note_section\s*\(/);
  const vitalsAt = text.search(/INSERT INTO\s+visit_vitals\s*\(/);

  const tpl = insertStatement(sql, "note_template");
  if (!tpl) {
    problems.push("the seed creates no note_template");
  } else {
    if (!tpl.includes(`'${DEFAULT_TEMPLATE_NAME}', 1, TRUE, 'default'`)) {
      problems.push(`the note_template insert is not an active version 1 of '${DEFAULT_TEMPLATE_NAME}' from 'default'`);
    }
    if (!/NOT EXISTS\s*\(\s*SELECT 1 FROM note_template\s+\w+\s+WHERE[^()]*\bis_active\b/.test(tpl)) {
      problems.push("the note_template insert has no NOT EXISTS guard on an active template, so a re-run fails on note_template_one_active_per_org");
    }
    if (text.search(/INSERT INTO\s+note_template\s*\(/) > notesAt) {
      problems.push("the note template is created after the notes are written");
    }
  }

  const sec = insertStatement(sql, "note_template_section");
  if (!sec) {
    problems.push("the seed writes no note_template_section");
  } else {
    if (!/\bdemo_seed_template_section\b/.test(sec)) {
      problems.push("the note_template_section insert does not read demo_seed_template_section");
    }
    if (!/NOT EXISTS\s*\(\s*SELECT 1 FROM note_template_section\s+\w+\s+WHERE[^()]*\btemplate_id\b[^()]*\bsection_key\b/.test(sec)) {
      problems.push("the note_template_section insert has no NOT EXISTS guard on (template_id, section_key), so a re-run adds a second copy");
    }
    if (!/\bversion = 1\b/.test(sec)) {
      problems.push("the note_template_section insert is not limited to version 1, so a re-run writes default sections into the org's own edit");
    }
  }

  const pinAt = text.search(/UPDATE visit\s+\w+\s+SET note_template_id\s*=/);
  if (pinAt < 0) {
    problems.push("no statement pins the seeded notes to the note template");
  } else {
    const pin = statementAt(text, pinAt);
    if (!/\bnote_template_id IS NULL\b/.test(pin)) problems.push("the pin overwrites a pin the visit already has");
    if (!/\bversion = 1\b/.test(pin)) problems.push("the pin is not limited to version 1");
    if (!/\bdemo_seed_note\b/.test(pin)) {
      problems.push(
        "the pin is not limited to the visits whose notes this run wrote, so a visit documented in the app is re-pinned to version 1",
      );
    }
    // Recording vitals starts a note too, and the seed writes vitals on every
    // signed home visit. One left unpinned would follow the org's later
    // version once it edits its template — the hole 0105 backfills.
    if (!/\bvisit_vitals\b/.test(pin)) {
      problems.push(
        "the pin does not cover the visits whose vitals this run wrote, so a seeded vitals-only note follows a later template version",
      );
    }
    if (notesAt < 0 || pinAt < notesAt) problems.push("the pin runs before the notes are written, so a first run pins nothing");
    if (vitalsAt < 0 || pinAt < vitalsAt) {
      problems.push("the pin runs before the vitals are written, so a first run leaves a vitals-only note unpinned");
    }
  }

  // The pin's IS NULL guard only means something if a re-run leaves the pin
  // alone. The visit upsert used to reset it, and the pin then moved every
  // seeded visit with a note back to version 1, including one the app had
  // pinned to the org's own later version (found by the R20 review).
  const visitInsert = insertStatement(sql, "visit");
  if (visitInsert && /\bnote_template_id\s*=\s*NULL\b/i.test(visitInsert)) {
    problems.push("the visit upsert clears note_template_id on a re-run, so a pin the app wrote is lost");
  }

  // What the section INSERT actually wrote, not just the VALUES list the
  // template checks read: a drift in its column list or SELECT passes those.
  const blocks = text.match(/DO \$\$[\s\S]*?END \$\$;/g) ?? [];
  if (
    !blocks.some(
      (b) => /\bEXCEPT\b/.test(b) && /\bdemo_seed_template_section\b/.test(b) && /\bnote_template_section\b/.test(b),
    )
  ) {
    problems.push(
      "no closing check compares the written template with demo_seed_template_section, so a drift in the section INSERT goes unnoticed",
    );
  }

  // The template's help text, like the visit-type labels, carries em dashes.
  // psql sends the file in the console's encoding unless told otherwise, and a
  // Windows console stored every one as 'â€”'.
  const encAt = text.search(/SET client_encoding\s*=\s*'UTF8'/i);
  const beginAt = text.search(/^BEGIN;/m);
  if (encAt < 0 || (beginAt >= 0 && encAt > beginAt)) {
    problems.push("the seed does not set client_encoding to UTF8 before it writes, so a Windows psql stores its em dashes as mojibake");
  }
  return problems;
}

// ---- the specs ------------------------------------------------------------

describe("demo seed — staff permissions", () => {
  it("grants each role template exactly ROLE_DEFAULT_PERMISSIONS", () => {
    expect(roleBlocks(SEED).map((b) => b.marker).sort()).toEqual(
      ["billing_agent", "clinician", "org_admin", "read_only"],
    );
    expect(permissionDrift(SEED)).toEqual([]);
  });

  it("control: a block with one permission removed fails", () => {
    const broken = SEED.replace("'team.view', 'team.invite',", "'team.view',");
    expect(broken).not.toBe(SEED);
    expect(permissionDrift(broken)).toContain("role:org_admin is missing team.invite");
  });

  it("control: a block granting more than the template fails", () => {
    const broken = SEED.replace("'reports.view',\n  'audit.view'\n]", "'reports.view',\n  'audit.view', 'team.invite'\n]");
    expect(broken).not.toBe(SEED);
    expect(permissionDrift(broken)).toContain("role:read_only grants team.invite beyond the template");
  });
});

describe("demo seed — visit notes", () => {
  it("writes only section keys the default template declares, as the kind it declares", () => {
    expect(sectionDrift(SEED)).toEqual([]);
  });

  it("control: an unknown section key fails, and so does dropping a required one", () => {
    const broken = SEED.replace("('hpi',                 'prose', FALSE),", "('history_of_present_illness', 'prose', FALSE),");
    expect(broken).not.toBe(SEED);
    expect(sectionDrift(broken)).toEqual(
      expect.arrayContaining([
        "section history_of_present_illness is not in DEFAULT_SECTION_KEYS",
        "required section hpi is never written",
      ]),
    );
  });
});

// The note preview, the audit packet, the sign guard and the documentation
// check read a visit's sections through its pinned template, else the org's
// active one. A real org gets that template from ensureNoteTemplate on its
// first note read; the demo org is built in SQL, and before the seed made one
// every signed demo note previewed as "Nothing has been written yet".
describe("demo seed — note template", () => {
  it("creates the template ensureNoteTemplate would, section for section", () => {
    expect(templateRows(SEED).map((r) => r.sectionKey)).toEqual(DEFAULT_SECTION_KEYS);
    expect(templateDrift(SEED)).toEqual([]);
  });

  it("guards each insert for a re-run, and pins the seeded notes to it once they are written", () => {
    expect(templateWriteDrift(SEED)).toEqual([]);
  });

  it("control: a section missing, or a label changed, fails", () => {
    const missing = SEED.replace(/\n  \('family_history',[^\n]*\n/, "\n");
    expect(missing).not.toBe(SEED);
    expect(templateDrift(missing)).toEqual(["template section family_history is missing"]);

    const relabelled = SEED.replace(/('physical_exam',\s+)'Physical examination'/, "$1'Physical exam'");
    expect(relabelled).not.toBe(SEED);
    expect(templateDrift(relabelled)).toEqual([
      'template section physical_exam: label is "Physical exam", DEFAULT_NOTE_SECTIONS says "Physical examination"',
    ]);
  });

  it("control: a changed exemption, a missing guard or a missing pin fails", () => {
    const exemption = SEED.replace(/(\('vitals',[^\n]*\n\s+ARRAY\['advance_care_planning', )'telehealth', /, "$1");
    expect(exemption).not.toBe(SEED);
    expect(templateDrift(exemption)).toEqual([
      'template section vitals: notRequiredForVisitTypes is ["advance_care_planning","bereavement_follow_up"], ' +
        'DEFAULT_NOTE_SECTIONS says ["advance_care_planning","telehealth","bereavement_follow_up"]',
    ]);

    const secondActive = SEED.replace(
      /\n WHERE NOT EXISTS \(SELECT 1 FROM note_template t\n\s+WHERE t\.org_id = '[0-9a-f-]+' AND t\.is_active\);/,
      ";",
    );
    expect(secondActive).not.toBe(SEED);
    expect(templateWriteDrift(secondActive)).toEqual([
      "the note_template insert has no NOT EXISTS guard on an active template, so a re-run fails on note_template_one_active_per_org",
    ]);

    const secondCopy = SEED.replace(
      /\n\s+AND NOT EXISTS \(SELECT 1 FROM note_template_section x\n\s+WHERE x\.template_id = t\.id AND x\.section_key = d\.section_key\);/,
      ";",
    );
    expect(secondCopy).not.toBe(SEED);
    expect(templateWriteDrift(secondCopy)).toEqual([
      "the note_template_section insert has no NOT EXISTS guard on (template_id, section_key), so a re-run adds a second copy",
    ]);

    const unpinned = SEED.replace(/\nUPDATE visit v\n[\s\S]*?;\n/, "\n");
    expect(unpinned).not.toBe(SEED);
    expect(templateWriteDrift(unpinned)).toEqual(["no statement pins the seeded notes to the note template"]);
  });

  // The R20 review's three findings on this template, each pinned by a copy
  // of the seed that brings the old behaviour back.
  it("control: a re-run that clears the pin, a pin reaching app-written notes, no encoding, or no row check fails", () => {
    const clearsPin = SEED.replace(
      "  -- note_template_id is left as it is: see the pin below.\n",
      "  note_template_id              = NULL,\n",
    );
    expect(clearsPin).not.toBe(SEED);
    expect(templateWriteDrift(clearsPin)).toEqual([
      "the visit upsert clears note_template_id on a re-run, so a pin the app wrote is lost",
    ]);

    const widePin = SEED.replace(
      "(v.id IN (SELECT DISTINCT nt.visit_id FROM demo_seed_note nt)",
      "(EXISTS (SELECT 1 FROM visit_note_section s WHERE s.visit_id = v.id)",
    );
    expect(widePin).not.toBe(SEED);
    expect(templateWriteDrift(widePin)).toEqual([
      "the pin is not limited to the visits whose notes this run wrote, so a visit documented in the app is re-pinned to version 1",
    ]);

    // The vitals arm, and the move below the vitals insert that lets a first
    // run see them: a seeded vitals-only note is unpinned without either.
    const notesOnlyPin = SEED.replace(
      "\n        OR v.id IN (SELECT DISTINCT vr.id FROM demo_seed_visit_row vr\n                      JOIN visit_vitals vv ON vv.visit_id = vr.id)",
      "",
    );
    expect(notesOnlyPin).not.toBe(SEED);
    expect(templateWriteDrift(notesOnlyPin)).toEqual([
      "the pin does not cover the visits whose vitals this run wrote, so a seeded vitals-only note follows a later template version",
    ]);

    const pinBlock = SEED.match(/\nUPDATE visit v\n[\s\S]*?;\n/)![0];
    const pinnedEarly = SEED.replace(pinBlock, "\n").replace(
      "INSERT INTO visit_vitals (",
      `${pinBlock.trim()}\n\nINSERT INTO visit_vitals (`,
    );
    expect(pinnedEarly).not.toBe(SEED);
    expect(templateWriteDrift(pinnedEarly)).toEqual([
      "the pin runs before the vitals are written, so a first run leaves a vitals-only note unpinned",
    ]);

    const noEncoding = SEED.replace("\nSET client_encoding = 'UTF8';\n", "\n");
    expect(noEncoding).not.toBe(SEED);
    expect(templateWriteDrift(noEncoding)).toEqual([
      "the seed does not set client_encoding to UTF8 before it writes, so a Windows psql stores its em dashes as mojibake",
    ]);

    const noRowCheck = SEED.replace(/\n  -- The template the seed writes must be DEFAULT_NOTE_SECTIONS[\s\S]*?END IF;\n/, "\n");
    expect(noRowCheck).not.toBe(SEED);
    expect(templateWriteDrift(noRowCheck)).toEqual([
      "no closing check compares the written template with demo_seed_template_section, so a drift in the section INSERT goes unnoticed",
    ]);
  });
});

describe("demo seed — visit types and services", () => {
  it("books every visit under a visit type the seed creates", () => {
    expect(visitTypeDrift(SEED)).toEqual([]);
  });

  it("control: a visit booked under a type the org lacks fails", () => {
    const broken = SEED.replace(
      "(16,  2, 'np_raman',   -19, '15:00', 'telehealth',",
      "(16,  2, 'np_raman',   -19, '15:00', 'bereavement_follow_up',",
    );
    expect(broken).not.toBe(SEED);
    expect(visitTypeDrift(broken)).toEqual([
      "visits are booked as bereavement_follow_up, which the seed never creates for the org",
    ]);
  });

  it("creates exactly the visit types signup gives a new org", () => {
    const rows = insertedRows(SEED, "org_visit_type").map((r) => ({
      slug: str(r.slug),
      label: str(r.label),
      codingBasis: str(r.coding_basis),
      isTelehealth: String(r.is_telehealth).toUpperCase() === "TRUE",
      sortOrder: Number(r.sort_order),
    }));
    // The band is codingBasis, not the slug (audit R22): 'telehealth' is a
    // seeded slug but no longer a band, and 0099's CHECK refuses it.
    expect(rows).toEqual(
      DEFAULT_VISIT_TYPES.map((t) => ({
        slug: t.slug,
        label: t.label,
        codingBasis: t.codingBasis,
        isTelehealth: t.isTelehealth,
        sortOrder: t.sortOrder,
      })),
    );
  });

  it("creates exactly the starter service catalog signup gives a new org", () => {
    const rows = insertedRows(SEED, "visit_service").map((r) => ({
      name: str(r.name),
      description: str(r.description),
      category: str(r.category),
      cptHint: str(r.cpt_hint),
      sortOrder: Number(r.sort_order),
    }));
    expect(rows).toEqual(
      DEFAULT_VISIT_SERVICES.map(({ name, description, category, cptHint, sortOrder }) => ({
        name, description, category, cptHint, sortOrder,
      })),
    );
  });
});

describe("demo seed — billing", () => {
  it("falls back to the same reference rates the app prices from", () => {
    const rows = insertedRows(SEED, "demo_seed_ref_rate");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const code = str(r.code)!;
      expect(Number(r.md_cents), code).toBe(estimateRateCents(code, "MD"));
      expect(Number(r.np_pa_cents), code).toBe(estimateRateCents(code, "NP_PA"));
    }
  });

  it("bills only codes with a reference rate, so no bill can price at $0", () => {
    const rated = new Set(insertedRows(SEED, "demo_seed_ref_rate").map((r) => str(r.code)));
    const billed = insertedRows(SEED, "demo_seed_visit").flatMap((r) => strArray(r.cpt));
    expect(billed.length).toBeGreaterThan(0);
    expect(billed.filter((c) => !rated.has(c))).toEqual([]);
  });
});

describe("demo seed — identifiers and credentials", () => {
  it("gives clinicians no NPI, and uses no NPI-shaped number but the org's CMS example", () => {
    const cols = /INSERT INTO clinician_profile\s*\(([^)]*)\)/.exec(SEED)?.[1] ?? "";
    expect(cols).toContain("credential");
    expect(cols).not.toMatch(/\bnpi\b/);
    const tenDigit = new Set(stripComments(SEED).match(/\b\d{10}\b/g) ?? []);
    expect([...tenDigit]).toEqual(["1234567893"]);
  });

  it("holds no password hash, and writes password_hash only inside the demo_password block", () => {
    expect(SEED).not.toMatch(/\$2[aby]\$\d{2}\$/);
    const block = /^\\if :\{\?demo_password\}\r?\n([\s\S]*?)^\\endif/m.exec(SEED);
    // One bcrypt cost-12 hash of the psql variable, applied to every seeded account.
    expect(block?.[1]).toMatch(/FROM \(SELECT crypt\(:'demo_password', gen_salt\('bf', 12\)\) AS hash\) h/);
    expect(block?.[1]).toMatch(/SET password_hash = h\.hash/);
    // The password is in that statement's text, so statement logging is off
    // for the transaction BEFORE it runs: no server log captures it, even one
    // that records slow statements (R20 review).
    const body = block![1];
    for (const s of [
      "SET LOCAL log_statement = 'none';",
      "SET LOCAL log_min_duration_statement = -1;",
      "SET LOCAL log_min_error_statement = 'panic';",
    ]) {
      expect(body.indexOf(s)).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(s)).toBeLessThan(body.indexOf("UPDATE app_user"));
    }
    const outside = stripComments(SEED.replace(block![0], ""));
    expect(outside).not.toMatch(/password_hash/);
  });
});

// 0103 moved the emergency contact and the referring physician off the
// patient row, and its one-time copy runs before any seed on a fresh
// database. A seed still writing the old columns would leave every demo
// chart's Family & caregivers card empty and every note header's referring
// physician blank (audit R30).
describe("demo seed — family, caregivers and referring physicians", () => {
  it("writes none of the patient columns 0103 retired", () => {
    expect(retiredColumnWrites(SEED)).toEqual([]);
  });

  it("control: writing a retired column again fails, in the column list or the ON CONFLICT", () => {
    const broken = SEED
      .replace(
        "address_line_1, city, state, zip, phone,\n  primary_payer_id",
        "address_line_1, city, state, zip, phone, emergency_contact_name,\n  primary_payer_id",
      )
      .replace(
        "  palliative_referral_reason = EXCLUDED.palliative_referral_reason,",
        "  palliative_referral_reason = EXCLUDED.palliative_referral_reason,\n  referring_physician_name  = EXCLUDED.referring_physician_name,",
      );
    expect(broken).not.toBe(SEED);
    expect(retiredColumnWrites(broken)).toEqual(["emergency_contact_name", "referring_physician_name"]);
  });

  it("fills 0103's tables instead, each insert guarded so a re-run adds no second copy", () => {
    expect(circleDrift(SEED)).toEqual([]);
    // CI runs the seed against a real database, and its closing check holds
    // every demo patient to a contact and a referring physician.
    expect(SEED).toMatch(/patient\(s\) have no family contact or no referring physician/);
  });

  it("control: an unguarded insert, an unmapped relationship or one the table refuses fails", () => {
    const unguarded = SEED.replace(
      /\n WHERE NOT EXISTS \(SELECT 1 FROM patient_external_provider x\n\s+WHERE x\.patient_id = p\.id AND x\.role = rl\.role\);/,
      ";",
    );
    expect(unguarded).not.toBe(SEED);
    expect(circleDrift(unguarded)).toEqual([
      "the patient_external_provider insert has no NOT EXISTS guard on role, so a re-run adds a second copy",
    ]);

    const unmapped = SEED.replace("'Grace Oduya (sister)'", "'Grace Oduya (cousin)'");
    expect(unmapped).not.toBe(SEED);
    expect(circleDrift(unmapped)).toEqual(["Grace Oduya (cousin) would be saved as 'other'"]);

    const refused = SEED.replace(/WHEN 'sister'(\s+)THEN 'sibling'/, "WHEN 'sister'$1THEN 'sister'");
    expect(refused).not.toBe(SEED);
    expect(circleDrift(refused)).toEqual(["'sister' is saved as sister, which patient_contact does not accept"]);
  });
});
