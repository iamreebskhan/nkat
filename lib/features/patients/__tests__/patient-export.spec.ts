/**
 * The patient record export carries the signed notes, a shared visit ID and
 * the patient on every page (audit R28).
 *
 * Two levels: pure tests of the renderer, and the real exportPatientRecord
 * run against a fake database. The second exists because the renderer tests
 * feed it canned section rows, so nothing tested the SQL that fetches them —
 * in particular the COALESCE resolving a visit's note to its own pinned
 * template version, else the org's active one. This document is handed to a
 * patient or a lawyer as the designated record set: resolved to the wrong
 * version, sections the note actually holds silently fall out of it (the join
 * drops any key the wrong version does not declare) and the ones that remain
 * are headed with labels the clinician never wrote under.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  setContent: vi.fn(),
  pdf: vi.fn(),
  closePage: vi.fn(),
  logPhiExport: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
// No browser and no PHI log row: the export's SQL and its HTML are what is
// under test here.
vi.mock("puppeteer", () => ({ default: { launch: h.launch } }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({
  logPhiExport: h.logPhiExport,
  logPhiAccess: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";

import {
  exportPatientRecord,
  renderPatientRecordHtml,
  type RecordNotes,
  type RecordSuperbill,
  type RecordVisit,
} from "../patient-export.service";

const SIGNED_ID = "e0000000-0000-4000-8000-00000000000a";
const DRAFT_ID = "e0000000-0000-4000-8000-00000000000c";

const patient = {
  id: "f0000000-0000-4000-8000-000000000001",
  first_name: "Stephen", last_name: "Singleton", date_of_birth: new Date("1936-01-19"),
  primary_payer_name: null, primary_member_id: "M-777",
};

const visit = (id: string, status: string, extra: Partial<RecordVisit> = {}): RecordVisit => ({
  id, visit_type: "established_patient_home", visit_type_label: "Established patient — home",
  status, scheduled_start: null, start_time: new Date("2026-09-09T15:00:00Z"), total_minutes: 45,
  cpt_codes: ["99349"], icd10_codes: ["C34.10"], signed_at: status === "billed" ? new Date("2026-09-11T17:33:00Z") : null,
  signed_by_user_id: "u1", clinician_user_id: "u1", signer_name: "Test Admin", signer_credential: "NP",
  document_text: null, ...extra,
});

const bill: RecordSuperbill = {
  id: "b2e303af-e2cb-4292-8d00-c35c07423a0d", visit_id: SIGNED_ID, status: "submitted",
  date_of_service: new Date("2026-06-09"), cpt_codes: ["99344"], billed_amount_cents: BigInt(11401),
  paid_amount_cents: null,
};

const prose = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

const notes = (over: Partial<RecordNotes> = {}): RecordNotes => ({
  sections: [
    { visit_id: SIGNED_ID, label: "History of present illness", kind: "prose", content: prose("Pain improved to 3/10."), is_empty: false, carried_unchanged: false },
    { visit_id: DRAFT_ID, label: "History of present illness", kind: "prose", content: prose("DRAFT TEXT"), is_empty: false, carried_unchanged: false },
  ],
  vitals: [{ visit_id: SIGNED_ID, weight_kg: "61.4", bp_systolic: 118, bp_diastolic: 72 }],
  addenda: [{ visit_id: SIGNED_ID, body: "Late entry: daughter present.", author_name: "Test Admin", author_credential: "NP", signed_at: new Date("2026-09-12T10:00:00Z") }],
  ...over,
});

const META = { orgName: "Design Partner", timeZone: "America/New_York" };

const render = (visits: RecordVisit[], n: RecordNotes = notes()) =>
  renderPatientRecordHtml(META, patient, visits, [bill], null, n);

/** 8:30 pm EDT on 9 Sep, which is already the 10th in UTC. */
const EVENING = new Date("2026-09-10T00:30:00Z");

describe("renderPatientRecordHtml", () => {
  it("carries the full visit ID in the visits table, the bill row and the note header — the join key", () => {
    const html = render([visit(SIGNED_ID, "billed"), visit(DRAFT_ID, "in_progress")]);
    const occurrences = html.split(SIGNED_ID).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it("includes a signed visit's note, its addendum and its attestation", () => {
    const html = render([visit(SIGNED_ID, "billed")]);
    expect(html).toContain("Pain improved to 3/10.");
    expect(html).toContain("Late entry: daughter present.");
    expect(html).toContain("Electronically signed by <strong>Test Admin</strong>, NP");
  });

  it("leaves a note that is still being written out of the record set", () => {
    const html = render([visit(SIGNED_ID, "billed"), visit(DRAFT_ID, "in_progress")]);
    expect(html).not.toContain("DRAFT TEXT");
  });

  it("renders a legacy JSON note as prose, never raw JSON, and escapes legacy text", () => {
    const legacy = render(
      [visit(SIGNED_ID, "billed", { document_text: JSON.stringify(prose("Legacy note.")) })],
      notes({ sections: [], vitals: [], addenda: [] }),
    );
    expect(legacy).toContain("<p>Legacy note.</p>");
    expect(legacy).not.toContain('{"type":"doc"');

    const plain = render(
      [visit(SIGNED_ID, "billed", { document_text: "BP <130/80>" })],
      notes({ sections: [], vitals: [], addenda: [] }),
    );
    expect(plain).toContain("BP &lt;130/80&gt;");
  });

  it("escapes markup inside a section", () => {
    const html = render(
      [visit(SIGNED_ID, "billed")],
      notes({ sections: [{ visit_id: SIGNED_ID, label: "HPI", kind: "prose", content: prose("<img onerror=x>"), is_empty: false, carried_unchanged: false }] }),
    );
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).not.toContain("<img onerror");
  });

  it("prints vitals in the units they were entered in", () => {
    const html = render([visit(SIGNED_ID, "billed")]);
    expect(html).toContain("lb");
    expect(html).toContain("118/72");
  });

  it("says so when no visit has a signed note", () => {
    const html = render([visit(DRAFT_ID, "in_progress")]);
    expect(html).toContain("No signed notes.");
  });

  it("carries family, caregivers and outside providers, escaped (audit R30)", () => {
    const html = renderPatientRecordHtml(
      META, patient, [visit(SIGNED_ID, "billed")], [bill], null, notes(),
      {
        contacts: [{
          full_name: "Tom <b>Reyes</b>", relationship: "niece_nephew", phone: "614-555-0142", alt_phone: null,
          email: null, is_primary_caregiver: false, is_emergency_contact: true, is_healthcare_poa: true,
          lives_with_patient: false, notes: null,
        }],
        providers: [{
          role: "specialist", role_label: "Pulmonologist", full_name: "Dr Priya Nair", npi: "1234567893",
          specialty: null, practice_name: null, phone: null, fax: "614-555-0101",
        }],
      },
    );
    expect(html).toContain("Family &amp; caregivers (1)");
    expect(html).toContain("Tom &lt;b&gt;Reyes&lt;/b&gt;");
    expect(html).not.toContain("<b>Reyes</b>");
    expect(html).toContain("Niece/nephew");
    expect(html).toContain("Healthcare POA, Emergency contact");
    expect(html).toContain("Outside providers (1)");
    expect(html).toContain("<td>Pulmonologist</td>");
    expect(html).toContain("614-555-0101");
  });

  it("says none are on file when the chart has no contacts or providers", () => {
    const html = render([visit(SIGNED_ID, "billed")]);
    expect(html).toContain("Family &amp; caregivers (0)");
    expect(html).toContain("Outside providers (0)");
    expect(html).toContain("None on file.");
  });
});

/**
 * The record set dates each visit by the day it happened where the practice
 * is. It printed the visit start's UTC day, so every visit from 8 pm Eastern on
 * was dated the next day: the date on the note in the patient's own record
 * disagreed with the date of service on its bill.
 */
describe("renderPatientRecordHtml — visit dates are the practice's days", () => {
  const visitsRow = (html: string, id: string, dayIso: string) =>
    new RegExp(`<td class="id">${id}</td>\\s*<td class="mono">${dayIso}</td>`).test(html);

  it("CONTROL: an 8:30 pm EDT visit on the 9th is dated the 9th in its note heading", () => {
    const html = render([visit(SIGNED_ID, "billed", { start_time: EVENING })]);
    expect(html).toContain("<h3>2026-09-09 · Established patient — home</h3>");
    expect(html).not.toContain("<h3>2026-09-10 ·");
  });

  it("CONTROL: and in the visits table", () => {
    const html = render([visit(SIGNED_ID, "billed", { start_time: EVENING })]);
    expect(visitsRow(html, SIGNED_ID, "2026-09-09")).toBe(true);
    expect(visitsRow(html, SIGNED_ID, "2026-09-10")).toBe(false);
  });

  it("CONTROL: a visit with only a scheduled time is dated the same way", () => {
    const html = render([visit(DRAFT_ID, "in_progress", { start_time: null, scheduled_start: EVENING })]);
    expect(visitsRow(html, DRAFT_ID, "2026-09-09")).toBe(true);
  });

  it("CONTROL: the practice's own zone decides", () => {
    // 10:30 pm PDT on 9 Sep: already the 10th in New York.
    const html = renderPatientRecordHtml(
      { ...META, timeZone: "America/Los_Angeles" }, patient,
      [visit(SIGNED_ID, "billed", { start_time: new Date("2026-09-10T05:30:00Z") })], [bill], null, notes(),
    );
    expect(visitsRow(html, SIGNED_ID, "2026-09-09")).toBe(true);
  });

  it("CONTROL: the care plan's last update is the practice's day too", () => {
    const html = renderPatientRecordHtml(
      META, patient, [visit(SIGNED_ID, "billed")], [bill],
      { goals_of_care_summary: "Comfort-focused.", updated_at: new Date("2026-09-10T01:00:00Z") }, notes(),
    );
    expect(html).toContain("Last updated 2026-09-09");
  });

  it("CONTROL: the care plan's date is the practice's own zone's too", () => {
    // 10 pm PDT on 9 Sep: already 1 am on the 10th in New York.
    const html = renderPatientRecordHtml(
      { ...META, timeZone: "America/Los_Angeles" }, patient, [visit(SIGNED_ID, "billed")], [bill],
      { goals_of_care_summary: "Comfort-focused.", updated_at: new Date("2026-09-10T05:00:00Z") }, notes(),
    );
    expect(html).toContain("Last updated 2026-09-09");
  });

  it("twin: a daytime visit keeps its day, and a bill's DATE is printed as stored", () => {
    // Passes before and after the fix. The bill's date_of_service is a DATE
    // (UTC midnight from Prisma): read through the practice's zone it would
    // print the day before.
    const html = render([visit(SIGNED_ID, "billed")]);
    expect(visitsRow(html, SIGNED_ID, "2026-09-09")).toBe(true);
    expect(html).toMatch(new RegExp(`<td class="id">${SIGNED_ID}</td>\\s*<td class="mono">2026-06-09</td>`));
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
/** A second tenant, whose active template the fallback must never reach. */
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const V1 = "71000000-0000-4000-8000-000000000001";
const V2 = "72000000-0000-4000-8000-000000000002";
const V_OTHER = "73000000-0000-4000-8000-000000000003";

/** v2 is what an admin saves after dropping HPI and renaming the A&P heading. */
const TEMPLATE_SECTIONS: Record<string, { section_key: string; label: string }[]> = {
  [V1]: [
    { section_key: "hpi", label: "History of present illness" },
    { section_key: "assessment_and_plan", label: "Assessment and plan" },
  ],
  [V2]: [
    { section_key: "assessment_and_plan", label: "Assessment and plan (2026 revision)" },
    { section_key: "spiritual_assessment", label: "Spiritual assessment" },
  ],
  // The other tenant's active template: same section keys, its own headings.
  [V_OTHER]: [
    { section_key: "assessment_and_plan", label: "Assessment and plan (Northside Hospice)" },
  ],
};

/** The visit_note_section rows the clinician actually wrote, under v1. */
const WRITTEN = [
  { section_key: "hpi", text: "Pain improved to 3/10." },
  { section_key: "assessment_and_plan", text: "Continue current regimen." },
];

/** A second signed status: attested, not yet billed. Still record set. */
const DOC_ID = "e0000000-0000-4000-8000-00000000000d";

let db: {
  /**
   * visit.note_template_id — NULL when the visit's org had no active template
   * to pin it to, or its note predates pinning (carry-forward pins now).
   */
  pin: string | null;
  /** The visit rows this patient has, with the status each one is in. */
  visits: RecordVisit[];
  /**
   * The note_template rows carrying is_active, in the order an unordered
   * LIMIT 1 meets them. Another tenant's sits first, because that is what a
   * fallback which forgets nt.org_id = v.org_id would take.
   */
  actives: { orgId: string; templateId: string }[];
  /** The org row; the record set dates visits in its timezone. */
  org: { id: string; name: string; timezone: string };
};
let calls: string[] = [];

/** The template the export's join asked for, resolved as Postgres would. */
function resolvedTemplate(sql: string): string | null {
  const start = sql.indexOf("t.template_id =");
  const end = sql.indexOf("WHERE v.patient_id");
  if (start < 0 || end < 0) throw new Error("the sections query joined no template");
  const expr = sql.slice(start, end);

  // Each operand at the position the SQL writes it, first non-NULL wins — the
  // ORDER is read off the text, never assumed. Swap the COALESCE operands and
  // this resolves the org's current version over the version the note was
  // written under, which is the whole failure the fallback has to survive.
  return [
    { at: expr.indexOf("v.note_template_id"), id: db.pin },
    { at: expr.indexOf("nt.is_active"), id: activeTemplate(expr) },
  ]
    .filter((o) => o.at >= 0)
    .sort((a, b) => a.at - b.at)
    .find((o) => o.id)?.id ?? null;
}

/**
 * Which active template the fallback subquery finds. Scoped to the visit's own
 * org it is this patient's org's; unscoped it is whichever row the table hands
 * back first, which in a multi-tenant table is another org's — this patient's
 * note read under a template no one in their org has ever seen.
 */
function activeTemplate(expr: string): string | null {
  const rows = /nt\.org_id\s*=\s*v\.org_id/.test(expr)
    ? db.actives.filter((a) => a.orgId === ORG)
    : db.actives;
  return rows[0]?.templateId ?? null;
}

/**
 * Which visit statuses the sections statement admits, read off its own WHERE
 * clause the way resolvedTemplate reads the COALESCE. A statement with no
 * status predicate at all admits every status — which is exactly what
 * deleting the filter does, and what the fake must be able to show.
 */
function statusFilter(sql: string): (status: string) => boolean {
  const list = sql.match(/v\.status\s+IN\s*\(([^)]*)\)/)?.[1];
  if (!list) return () => true;
  const admitted = list.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  return (status) => admitted.includes(status);
}

/** The rows the sections statement actually returned, for the visits assertions. */
let sectionsFetched: { visit_id: string }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push(sql);
    // The org row, with only the columns the statement selects.
    const orgRead = /SELECT ([\w, ]+) FROM org WHERE id = ¶::uuid/.exec(sql);
    if (orgRead) {
      if (values[0] !== db.org.id) return Promise.resolve([]);
      const cols = orgRead[1]!.split(",").map((c) => c.trim());
      return Promise.resolve([
        Object.fromEntries(cols.map((c) => {
          if (!(c in db.org)) throw new Error(`org has no column ${c}`);
          return [c, db.org[c as keyof typeof db.org]];
        })),
      ]);
    }
    if (sql.includes("FROM patient p")) return Promise.resolve([patient]);
    if (sql.includes("FROM visit v")) return Promise.resolve(db.visits);
    if (sql.includes("FROM visit_note_section s")) {
      // The join: a written row survives only if the resolved template
      // declares its key, and is headed with THAT version's label. Which
      // visits it runs over is the statement's own business: sections belong
      // to rows in the visit table, and `v.status IN (...)` is what keeps a
      // note that is still being written out of the designated record set.
      const tpl = TEMPLATE_SECTIONS[resolvedTemplate(sql) ?? ""] ?? [];
      const admits = statusFilter(sql);
      const rows = db.visits
        .filter((v) => admits(v.status))
        .flatMap((v) =>
          tpl.flatMap((t) => {
            const w = WRITTEN.find((x) => x.section_key === t.section_key);
            return w
              ? [{
                  visit_id: v.id, label: t.label, kind: "prose", content: prose(w.text),
                  is_empty: false, carried_unchanged: false,
                }]
              : [];
          }),
        );
      sectionsFetched = rows;
      return Promise.resolve(rows);
    }
    if (sql.includes("FROM superbill")) return Promise.resolve([bill]);
    return Promise.resolve([]); // vitals, addenda, care plan, contacts, providers
  };
  return { $queryRaw: run };
}

const exportedHtml = () => h.setContent.mock.calls[0]![0] as string;

describe("exportPatientRecord reads each note under the version it was written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    sectionsFetched = [];
    db = {
      pin: V1,
      // One visit per status that matters: billed and documented are attested
      // and part of the record set, in_progress is a note still being written.
      visits: [visit(SIGNED_ID, "billed"), visit(DOC_ID, "documented"), visit(DRAFT_ID, "in_progress")],
      actives: [
        { orgId: OTHER_ORG, templateId: V_OTHER },
        { orgId: ORG, templateId: V2 },
      ],
      org: { id: ORG, name: "Design Partner", timezone: "America/New_York" },
    };
    h.setContent.mockResolvedValue(undefined);
    h.pdf.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    h.closePage.mockResolvedValue(undefined);
    h.launch.mockResolvedValue({
      connected: true,
      newPage: async () => ({ setContent: h.setContent, pdf: h.pdf, close: h.closePage }),
    });
    h.logPhiExport.mockResolvedValue(undefined);
    vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
      (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
    );
  });

  const run = () =>
    exportPatientRecord({ orgId: ORG, userId: USER, patientId: patient.id, orgName: "Design Partner" });

  it("gives a v1-pinned note v1's sections and v1's headings while v2 is active", async () => {
    const r = await run();
    expect(r.patientName).toBe("Stephen Singleton");

    const html = exportedHtml();
    // The section v2 dropped is still part of this patient's record. Put the
    // org's current version first in the COALESCE and this line goes: the
    // export hands over a record missing the HPI the clinician wrote.
    expect(html).toContain("History of present illness");
    expect(html).toContain("Pain improved to 3/10.");
    // Headed as the clinician wrote it, not as the current template reads.
    expect(html).toContain("<h4>Assessment and plan</h4>");
    expect(html).not.toContain("2026 revision");
    expect(html).not.toContain("No note recorded.");
  });

  it("CONTROL — an unpinned note falls back to the org's active version", async () => {
    // A note with no pin (documented by carry-forward, before every write
    // pinned) is read under the active version: without the fallback half of
    // the COALESCE the join would match nothing and the export would hand the
    // patient a record saying the signed visit holds no note at all.
    db.pin = null;
    await run();

    const html = exportedHtml();
    expect(html).toContain("<h4>Assessment and plan (2026 revision)</h4>");
    expect(html).toContain("Continue current regimen.");
    expect(html).not.toContain("No note recorded.");
    // v2 does not declare HPI, so that section is not part of this reading.
    expect(html).not.toContain("Pain improved to 3/10.");
  });

  it("falls back only to this patient's OWN org's active template", async () => {
    // Not the rare half: sign-off and carry-forward both pin, but a visit whose
    // org had no active template to pin it to, or whose note predates pinning,
    // carries no pin,
    // and those are 208 of the 251 documented visits in the demo data. The
    // fallback is a subquery over the whole note_template table, so drop
    // nt.org_id = v.org_id and LIMIT 1 takes whichever active row comes first
    // — a patient's designated record set resolved through another tenant's
    // template, headed with another tenant's wording.
    db.pin = null;
    await run();

    const html = exportedHtml();
    expect(html).toContain("<h4>Assessment and plan (2026 revision)</h4>");
    expect(html).not.toContain("Northside Hospice");

    // And the scoping itself, in the query that was actually sent.
    const sectionsSql = calls.find((s) => s.includes("FROM visit_note_section s"))!;
    expect(sectionsSql).toContain("nt.org_id = v.org_id");
  });

  /**
   * Only an attested note is part of the designated record set (the rule the
   * service states at the SIGNED set). The renderer re-filters to signed
   * visits, so today this predicate costs only wasted rows — but it is the
   * rule as SQL, and it is what any other consumer of notes.sections (a JSON
   * or structured export) would be relying on. Nothing exercised it: both
   * deleting it and narrowing it to ('billed') left the spec green.
   */
  it("fetches note sections for attested visits only, never for a note still being written", async () => {
    await run();
    const fetchedFor = new Set(sectionsFetched.map((s) => s.visit_id));
    expect(fetchedFor.has(SIGNED_ID)).toBe(true);
    expect(fetchedFor.has(DRAFT_ID)).toBe(false);
  });

  it("counts a documented note as attested, not only a billed one", async () => {
    await run();
    // Narrowing the status list to ('billed') would drop every note that is
    // signed but not yet through billing — 16 of them in the demo data.
    expect(sectionsFetched.some((s) => s.visit_id === DOC_ID)).toBe(true);
  });

  it("CONTROL: dates an evening visit in the org's own zone, read from the org", async () => {
    // 10:30 pm PDT on 9 Sep: the 10th in UTC and in New York.
    db.org = { ...db.org, timezone: "America/Los_Angeles" };
    db.visits = [visit(SIGNED_ID, "billed", { start_time: new Date("2026-09-10T05:30:00Z") })];
    await run();
    expect(exportedHtml()).toContain("<h3>2026-09-09 · Established patient — home</h3>");
  });

  it("uses the same COALESCE as the sign guard, which decides what a note owes", async () => {
    await run();
    const sectionsSql = calls.find((s) => s.includes("FROM visit_note_section s"))!;
    const ours = sectionsSql.match(/t\.template_id = (COALESCE\([\s\S]*?is_active\s*LIMIT 1\)\))/)?.[1];
    expect(ours).toBeDefined();

    const guardSrc = readFileSync(new URL("../../visits/visit.service.ts", import.meta.url), "utf8");
    const guard = guardSrc.match(/WHERE t\.template_id = (COALESCE\([\s\S]*?is_active\s*LIMIT 1\)\))/)?.[1];
    expect(guard).toBeDefined();

    // Whitespace collapses; nothing else may differ between the two.
    const squash = (s: string) => s.replace(/\s+/g, " ").replace(/\(\s+/g, "(");
    expect(squash(ours!)).toBe(squash(guard!));
  });
});
