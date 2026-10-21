/**
 * The structured note: what counts as a filled section, and how the sign-off
 * guard reads sections, vitals and the legacy free-text column together.
 *
 * Documentation can now live in three places and any one of them counts —
 * a filled section, a recorded vital sign, or the pre-0088 document_text that
 * older visits still hold. The guard has to accept all three, and separately
 * enforce whichever sections the org's own template marks required.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";
import {
  sectionContentIsEmpty,
  sectionIsRequiredFor,
  DEFAULT_NOTE_SECTIONS,
} from "../note-template";
import { transitionVisit } from "../visit.service";

describe("sectionContentIsEmpty", () => {
  it("prose: empty doc and whitespace-only text are empty", () => {
    expect(sectionContentIsEmpty("prose", { type: "doc", content: [] })).toBe(true);
    expect(
      sectionContentIsEmpty("prose", {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "  " }] }],
      }),
    ).toBe(true);
  });

  it("prose: real text counts", () => {
    expect(
      sectionContentIsEmpty("prose", {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Dyspnoea." }] }],
      }),
    ).toBe(false);
  });

  it("list: no items, blank items and non-arrays are empty", () => {
    expect(sectionContentIsEmpty("list", {})).toBe(true);
    expect(sectionContentIsEmpty("list", { items: [] })).toBe(true);
    expect(sectionContentIsEmpty("list", { items: ["", "   "] })).toBe(true);
    expect(sectionContentIsEmpty("list", { items: "not an array" })).toBe(true);
  });

  it("list: one real item counts", () => {
    expect(sectionContentIsEmpty("list", { items: ["Oxycodone 10mg q4h"] })).toBe(false);
  });

  it("vitals sections are never judged by their own content", () => {
    // Vitals live in visit_vitals; a vitals section carrying JSON would be a
    // second copy nobody reads, so this always reports empty by design.
    expect(sectionContentIsEmpty("vitals", { weightKg: 61.4 })).toBe(true);
  });
});

describe("the shipped default template", () => {
  it("requires the four sections Mark named, plus assessment and plan", () => {
    // [05:55] "each note that you have to have has an HPI ... social history
    // ... And then the rest is like a physical exam." [06:29] "you're going to
    // collect their vitals". Assessment and plan is ours — it is what the
    // billed code is defended with, and the audit packet reconciles against it.
    const required = DEFAULT_NOTE_SECTIONS.filter((s) => s.isRequired).map((s) => s.sectionKey);
    expect(required).toEqual([
      "hpi",
      "social_history",
      "vitals",
      "physical_exam",
      "assessment_and_plan",
    ]);
  });

  it("exempts a required section only where it cannot be produced at all", () => {
    const by = (k: string) => DEFAULT_NOTE_SECTIONS.find((s) => s.sectionKey === k)!;

    // No hands-on exam and no measurable weight over video or a phone call.
    for (const key of ["physical_exam", "vitals"]) {
      expect(by(key).notRequiredForVisitTypes).toContain("telehealth");
      expect(by(key).notRequiredForVisitTypes).toContain("advance_care_planning");
    }

    // At a bereavement follow-up the patient has died: nobody to examine, no
    // vitals, and no history of a present illness.
    for (const key of ["hpi", "social_history", "physical_exam", "vitals"]) {
      expect(by(key).notRequiredForVisitTypes).toContain("bereavement_follow_up");
    }

    // A home visit is exempt from nothing — that is the visit Mark described.
    const exempt = DEFAULT_NOTE_SECTIONS.filter((s) =>
      (s.notRequiredForVisitTypes ?? []).includes("new_patient_home"),
    );
    expect(exempt).toEqual([]);
  });

  it("never exempts assessment and plan — every encounter has a plan", () => {
    const ap = DEFAULT_NOTE_SECTIONS.find((s) => s.sectionKey === "assessment_and_plan")!;
    expect(ap.notRequiredForVisitTypes ?? []).toEqual([]);
  });

  it("gives no exceptions to a section that is not required in the first place", () => {
    // An exception list on an optional section is dead configuration that
    // reads as if it does something.
    for (const s of DEFAULT_NOTE_SECTIONS) {
      if (!s.isRequired) expect(s.notRequiredForVisitTypes ?? []).toEqual([]);
    }
  });
});

describe("sectionIsRequiredFor", () => {
  const exam = { isRequired: true, notRequiredForVisitTypes: ["telehealth"] };
  const optional = { isRequired: false, notRequiredForVisitTypes: [] };

  it("is required on a visit type not in the exception list", () => {
    expect(sectionIsRequiredFor(exam, "new_patient_home")).toBe(true);
  });

  it("is not required on an exempt visit type", () => {
    expect(sectionIsRequiredFor(exam, "telehealth")).toBe(false);
  });

  it("stays optional whatever the visit type", () => {
    expect(sectionIsRequiredFor(optional, "new_patient_home")).toBe(false);
    expect(sectionIsRequiredFor(optional, "telehealth")).toBe(false);
  });

  it("falls back to required when the visit type is unknown", () => {
    // Safer to ask for the section than to silently drop a block because a
    // visit row is missing its type.
    expect(sectionIsRequiredFor(exam, null)).toBe(true);
    expect(sectionIsRequiredFor(exam, undefined)).toBe(true);
  });

  it("treats a missing exception list as no exceptions", () => {
    expect(sectionIsRequiredFor({ isRequired: true }, "telehealth")).toBe(true);
    expect(sectionIsRequiredFor({ isRequired: true, notRequiredForVisitTypes: null }, "telehealth")).toBe(
      true,
    );
  });

  it("matches the whole slug, never a prefix", () => {
    const s = { isRequired: true, notRequiredForVisitTypes: ["telehealth"] };
    expect(sectionIsRequiredFor(s, "telehealth_followup")).toBe(true);
  });

  it("follows the visit's telehealth flag, not only its type (audit R22)", () => {
    // Vitals and exam are excepted for "telehealth", and a video visit on an
    // established type cannot produce them any more than one on the old
    // Telehealth type could.
    const vitals = DEFAULT_NOTE_SECTIONS.find((s) => s.sectionKey === "vitals")!;
    expect(sectionIsRequiredFor(vitals, "established_patient_home", true)).toBe(false);
    expect(sectionIsRequiredFor(vitals, "established_patient_home", false)).toBe(true);
    // Omitting the flag is the in-person answer, which every older caller gets.
    expect(sectionIsRequiredFor(vitals, "established_patient_home")).toBe(true);
  });

  it("telehealth exempts only what the template excepts for telehealth", () => {
    const by = (k: string) => DEFAULT_NOTE_SECTIONS.find((s) => s.sectionKey === k)!;
    expect(sectionIsRequiredFor(by("physical_exam"), "new_patient_home", true)).toBe(false);
    // History and the plan can be taken over video; they stay required.
    expect(sectionIsRequiredFor(by("hpi"), "new_patient_home", true)).toBe(true);
    expect(sectionIsRequiredFor(by("assessment_and_plan"), "new_patient_home", true)).toBe(true);
  });

  it("carries the sections Mark named, and drops the two he told us to ignore", () => {
    const keys = DEFAULT_NOTE_SECTIONS.map((s) => s.sectionKey);
    for (const named of ["hpi", "social_history", "physical_exam", "vitals"]) {
      expect(keys).toContain(named);
    }
    // "Please ignore the last sections about time capture and next visit, as
    // those sections are outdated." Time is captured structurally; scheduling
    // owns the next visit.
    expect(keys.some((k) => /time|next_visit|follow_up/.test(k))).toBe(false);
  });

  it("has unique keys and exactly one vitals section", () => {
    const keys = DEFAULT_NOTE_SECTIONS.map((s) => s.sectionKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DEFAULT_NOTE_SECTIONS.filter((s) => s.kind === "vitals")).toHaveLength(1);
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000a";

let row: Record<string, unknown>;
let calls: string[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray) => {
    const sql = strings.join("¶");
    calls.push(sql);
    if (sql.includes("FROM visit") && sql.includes("SELECT")) {
      return Promise.resolve(row.status ? [row] : []);
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}
const signed = () => calls.some((s) => s.includes("UPDATE visit SET"));

beforeEach(() => {
  calls = [];
  row = {
    status: "in_progress",
    document_text: null,
    filled_sections: 0,
    has_vitals: false,
    missing_required: null,
    dx_count: 1,
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("transitionVisit with a structured note", () => {
  it("accepts a filled section as documentation", async () => {
    row.filled_sections = 2;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).resolves.toEqual({ from: "in_progress", to: "documented" });
    expect(signed()).toBe(true);
  });

  it("accepts a recorded vital sign as documentation", async () => {
    // A visit where the clinician recorded a weight and nothing else is thin,
    // but it is not undocumented — refusing it would be wrong.
    row.has_vitals = true;
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).resolves.toBeTruthy();
  });

  it("still accepts a pre-0088 free-text note", async () => {
    row.document_text =
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Seen at home."}]}]}';
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).resolves.toBeTruthy();
  });

  it("refuses when all three are empty", async () => {
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).rejects.toThrow(/no documentation/i);
    expect(signed()).toBe(false);
  });

  it("names the missing required sections rather than refusing vaguely", async () => {
    row.filled_sections = 1;
    row.missing_required = ["History of present illness", "Assessment and plan"];
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).rejects.toThrow(/History of present illness, Assessment and plan/);
    expect(signed()).toBe(false);
  });

  it("uses the singular when exactly one section is missing", async () => {
    row.filled_sections = 1;
    row.missing_required = ["Assessment and plan"];
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "documented" }),
    ).rejects.toThrow(/missing a required section: Assessment and plan\. Complete it/);
  });

  it("CONTROL — required sections are not re-checked on later transitions", async () => {
    // Visits signed before a template tightened its required set must still
    // reach billing; the check belongs on the sign-off edge only.
    row.status = "documented";
    row.missing_required = ["Assessment and plan"];
    await expect(
      transitionVisit({ orgId: ORG, id: VISIT, to: "pending_billing" }),
    ).resolves.toEqual({ from: "documented", to: "pending_billing" });
  });
});
