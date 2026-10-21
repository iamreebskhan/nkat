/**
 * Payer documentation requirements against the note (audit R19).
 *
 * UnitedHealthcare Community Plan Ohio's manual requires vital signs, chief
 * complaint, physical assessment, diagnosis and treatment plan on every visit
 * note, and an audio-video statement on a telehealth one. Pallio held that
 * standard and a structured note and never compared them. These tests hold
 * the comparison to one rule above all: what the record cannot show is never
 * reported as documented.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/api";

import {
  DocumentationIncompleteError,
  checkDocumentation,
  documentationFindings,
  documentationGap,
  documentationGapMessage,
  type DocumentationFacts,
} from "../documentation-check";

const UHC = ["vitals", "chief_complaint", "physical_exam", "diagnosis", "plan", "telehealth_modality"];
const TEMPLATE = ["reason_for_visit", "chief_complaint", "hpi", "vitals", "physical_exam", "assessment_and_plan"];

const complete: DocumentationFacts = {
  filledSections: ["chief_complaint", "hpi", "physical_exam", "assessment_and_plan"],
  templateSections: TEMPLATE,
  hasVitals: true,
  dxCount: 1,
  isTelehealth: false,
  telehealthModality: null,
  totalMinutes: 45,
};

const req = (code = "99349", elements = UHC) => [{ code, elements }];
const check = (facts: Partial<DocumentationFacts>, reqs = req()) =>
  checkDocumentation(reqs, { ...complete, ...facts });

describe("checkDocumentation", () => {
  it("passes a visit that documents every element", () => {
    const [r] = check({});
    expect(r!.missing).toEqual([]);
    expect(r!.unverifiable).toEqual([]);
  });

  it("names a missing chief complaint in the payer's words", () => {
    const [r] = check({ filledSections: ["hpi", "physical_exam", "assessment_and_plan"] });
    expect(r!.missing).toEqual([{ element: "chief_complaint", label: "Chief complaint" }]);
  });

  it("maps the plan to the Assessment and plan section", () => {
    const [r] = check({ filledSections: ["chief_complaint", "physical_exam"] });
    expect(r!.missing.map((m) => m.element)).toEqual(["plan"]);
  });

  it("ignores the telehealth element on an in-person visit", () => {
    const [r] = check({ isTelehealth: false, telehealthModality: null });
    expect(r!.missing).toEqual([]);
    expect(r!.required.map((e) => e.element)).not.toContain("telehealth_modality");
  });

  it("requires an audio-video statement on a telehealth visit; audio-only cannot meet it", () => {
    expect(check({ isTelehealth: true, telehealthModality: null })[0]!.missing.map((m) => m.element)).toEqual([
      "telehealth_modality",
    ]);
    expect(check({ isTelehealth: true, telehealthModality: "audio_only" })[0]!.missing).toEqual([
      { element: "telehealth_modality", label: "Audio-video telehealth statement" },
    ]);
    expect(check({ isTelehealth: true, telehealthModality: "audio_video" })[0]!.missing).toEqual([]);
  });

  it("counts a diagnosis only when the visit carries an ICD-10 code", () => {
    expect(check({ dxCount: 0 })[0]!.missing.map((m) => m.element)).toEqual(["diagnosis"]);
    expect(check({ dxCount: 2 })[0]!.missing).toEqual([]);
  });

  it("judges vitals by the readings, never by a vitals section row", () => {
    // A vitals section's content lives in visit_vitals, so a row keyed
    // 'vitals' proves nothing.
    const [r] = check({ hasVitals: false, filledSections: [...complete.filledSections, "vitals"] });
    expect(r!.missing.map((m) => m.element)).toEqual(["vitals"]);
  });

  it("never passes a section the org's template does not carry", () => {
    const [r] = check({
      templateSections: TEMPLATE.filter((k) => k !== "chief_complaint"),
      filledSections: ["hpi", "physical_exam", "assessment_and_plan"],
    });
    expect(r!.missing).toEqual([]);
    expect(r!.unverifiable.map((u) => u.element)).toEqual(["chief_complaint"]);
  });

  it("never passes an element name it does not know", () => {
    const [r] = check({}, req("99349", ["vitals", "nutrition_screen"]));
    expect(r!.unverifiable).toEqual([{ element: "nutrition_screen", label: "nutrition screen" }]);
  });

  it("combines several requirement rows for one code, and sorts codes", () => {
    const out = checkDocumentation(
      [
        { code: "99349", elements: ["vitals"] },
        { code: "g0318", elements: ["chief_complaint"] },
        { code: "99349", elements: ["vitals", "chief_complaint"] },
      ],
      { ...complete, filledSections: [] },
    );
    expect(out.map((r) => r.code)).toEqual(["99349", "G0318"]);
    expect(out[0]!.required.map((e) => e.element)).toEqual(["vitals", "chief_complaint"]);
  });
});

describe("documentationFindings", () => {
  const payer = "UnitedHealthcare Community Plan Ohio";

  it("says nothing when no requirement is on file", () => {
    expect(documentationFindings([], payer, { signed: true })).toEqual([]);
  });

  it("states a match, listing what was required", () => {
    const [f, ...rest] = documentationFindings(check({}), payer, { signed: true });
    expect(rest).toEqual([]);
    expect(f!.severity).toBe("match");
    expect(f!.label).toBe("Payer documentation");
    expect(f!.detail).toContain("99349");
    expect(f!.detail).toContain("Chief complaint");
  });

  it("is a discrepancy on a signed note, naming the payer, the code and the gap", () => {
    const [f] = documentationFindings(
      check({ filledSections: ["hpi", "physical_exam", "assessment_and_plan"] }),
      payer,
      { signed: true },
    );
    expect(f!.severity).toBe("mismatch");
    expect(f!.detail).toContain(payer);
    expect(f!.detail).toContain("99349");
    expect(f!.detail).toContain("Not documented in the signed note: Chief complaint.");
  });

  it("is unfinished work, not a discrepancy, before signing", () => {
    const [f] = documentationFindings(check({ filledSections: [] }), payer, { signed: false });
    expect(f!.severity).toBe("attention");
    expect(f!.detail).toContain("Not documented yet: Chief complaint, Physical assessment, Treatment plan.");
  });

  it("flags what it cannot check for attention, and never calls it a match", () => {
    const out = documentationFindings(
      check({ templateSections: TEMPLATE.filter((k) => k !== "chief_complaint") }),
      payer,
      { signed: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("attention");
    expect(out[0]!.detail).toContain("cannot check");
  });
});

describe("the submit gate", () => {
  it("has no gap when the note is complete", () => {
    expect(documentationGap(check({}), "UHC")).toBeNull();
  });

  it("carries the payer, the codes and the missing elements", () => {
    const g = documentationGap(check({ filledSections: ["hpi"], dxCount: 0 }), "UHC")!;
    expect(g.payerName).toBe("UHC");
    expect(g.codes).toEqual(["99349"]);
    expect(g.missing.map((m) => m.element)).toEqual(["chief_complaint", "physical_exam", "diagnosis", "plan"]);
    expect(documentationGapMessage(g)).toMatch(/^UHC requires Chief complaint, Physical assessment, Diagnosis, Treatment plan in the note for 99349/);
  });

  it("does not block on what it cannot check", () => {
    const g = documentationGap(check({}, req("99349", ["nutrition_screen"])), "UHC");
    expect(g).toBeNull();
  });

  it("is a ValidationError, so every route answers it at 422, and keeps the gap", () => {
    const g = documentationGap(check({ filledSections: ["hpi", "physical_exam", "assessment_and_plan"] }), "UHC")!;
    const err = new DocumentationIncompleteError(g);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.gap).toBe(g);
    expect(err.message).toContain("Chief complaint");
  });
});

describe("a note written before structured sections (pre-0088 free text)", () => {
  const legacy: Partial<DocumentationFacts> = { filledSections: [], hasVitals: false, dxCount: 0, legacyNote: true };

  it("reports what it cannot see as unverifiable, never missing, so it neither passes nor blocks", () => {
    const [r] = check(legacy);
    expect(r!.missing).toEqual([]);
    expect(r!.unverifiable.map((u) => u.element)).toEqual([
      "vitals", "chief_complaint", "physical_exam", "diagnosis", "plan",
    ]);
    expect(documentationGap(check(legacy), "UHC")).toBeNull();
  });

  it("still credits what the record does show", () => {
    const [r] = check({ ...legacy, hasVitals: true, dxCount: 1 });
    expect(r!.missing).toEqual([]);
    expect(r!.unverifiable.map((u) => u.element)).toEqual(["chief_complaint", "physical_exam", "plan"]);
  });

  it("CONTROL — a structured note with the same gaps is still missing them", () => {
    const [r] = check({ ...legacy, legacyNote: false });
    expect(r!.missing.map((m) => m.element)).toEqual([
      "vitals", "chief_complaint", "physical_exam", "diagnosis", "plan",
    ]);
  });
});
