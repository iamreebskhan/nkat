import { describe, expect, it } from "vitest";

import { assertNoPhi, checkForPhi, PhiGuardError } from "../phi-guard";

describe("checkForPhi", () => {
  it("passes a clean payer-rule prompt", () => {
    const r = checkForPhi(
      "Does Humana cover CPT 99349 in OH for telehealth? Effective date 2026-01-01.",
    );
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("flags SSN", () => {
    const r = checkForPhi("Patient SSN 123-45-6789 needs lookup.");
    expect(r.ok).toBe(false);
    expect(r.hits.some((h) => h.pattern === "ssn")).toBe(true);
  });

  it("flags phone numbers", () => {
    const r = checkForPhi("Call back at (555) 867-5309 for confirmation.");
    expect(r.ok).toBe(false);
    expect(r.hits.some((h) => h.pattern === "phone")).toBe(true);
  });

  it("flags emails", () => {
    const r = checkForPhi("Send notes to clinician@example.com please.");
    expect(r.ok).toBe(false);
    expect(r.hits.some((h) => h.pattern === "email")).toBe(true);
  });

  it("flags dates of birth", () => {
    const r = checkForPhi("DOB: 03/14/1949");
    expect(r.ok).toBe(false);
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("does NOT flag CPT codes (5 digits)", () => {
    const r = checkForPhi("CPT 99349 with modifier 95.");
    expect(r.ok).toBe(true);
  });

  it("does NOT flag effective dates in citation form (YYYY-MM-DD)", () => {
    const r = checkForPhi("Per CMS document, effective 2026-01-15.");
    // YYYY-MM-DD does NOT match dob_slash or dob_dash patterns.
    expect(r.hits.find((h) => h.pattern.startsWith("dob"))).toBeUndefined();
  });

  it("flags 'patient is John Smith' triggers", () => {
    const r = checkForPhi("Patient is John Smith, please confirm coverage.");
    expect(r.ok).toBe(false);
  });

  it("still flags a bare 'patient John Smith' (proper-cased name)", () => {
    expect(checkForPhi("Does Humana cover patient John Smith?").ok).toBe(false);
    expect(checkForPhi("member Jane Doe eligibility").ok).toBe(false);
  });

  it("does NOT flag lowercase billing phrasing (eval regression)", () => {
    // The /i flag made these trip 'name_trigger' and refused the
    // Anthropic call — caught by the gold-standard eval.
    for (const q of [
      "Does Medicare cover a new patient home visit (99341) in OH?",
      "established patient home visit 99349 telehealth Humana",
      "is member group number required for 99497 prior auth",
    ]) {
      expect(checkForPhi(q).ok, q).toBe(true);
    }
  });

  it("flags MRN-like long alphanumerics", () => {
    const r = checkForPhi("Member ID ABC123XY789 needs eligibility check.");
    expect(r.ok).toBe(false);
    expect(r.hits.some((h) => h.pattern === "mrn_like")).toBe(true);
  });

  it("does NOT read mrn_like's digit requirement past the token", () => {
    // The lookaheads used to be `(?=.*\d)`, which scanned to the end of
    // the line — so any ALL-CAPS word of 9+ letters counted as a member
    // ID as long as a digit appeared later in the sentence. This is the
    // false positive that refused the Aetna clinical policy bulletin.
    for (const s of [
      "TELEHEALTH SERVICES are covered under CPT 99349.",
      "PRIOR AUTHORIZATION is required. See section 4.",
      "REIMBURSEMENT POLICY CC.PP.051 applies to codes 99341-99350.",
    ]) {
      expect(checkForPhi(s).hits.find((h) => h.pattern === "mrn_like"), s)
        .toBeUndefined();
    }
    // ...while a token that really does mix digits in still trips.
    expect(
      checkForPhi("Member ID ABC123XY789").hits.some((h) => h.pattern === "mrn_like"),
    ).toBe(true);
  });

  it("redacts the excerpt — never echoes the raw match", () => {
    const r = checkForPhi("Patient SSN 123-45-6789 needs lookup.");
    const ssnHit = r.hits.find((h) => h.pattern === "ssn")!;
    expect(ssnHit.excerpt).not.toContain("123-45-6789");
    expect(ssnHit.excerpt).toMatch(/^1\*+9$/);
  });
});

describe("assertNoPhi", () => {
  it("returns silently when clean", () => {
    expect(() =>
      assertNoPhi("Does CMS cover G0317 in CA?", "rule_lookup"),
    ).not.toThrow();
  });

  it("throws PhiGuardError when tripped", () => {
    expect(() => assertNoPhi("DOB: 03/14/1949", "rule_lookup")).toThrowError(
      PhiGuardError,
    );
  });

  it("error message names the context but never echoes the suspected PHI", () => {
    try {
      assertNoPhi("SSN 999-00-1234 in here", "synth");
      expect.fail("Should have thrown.");
    } catch (e) {
      const err = e as PhiGuardError;
      expect(err.context).toBe("synth");
      expect(err.message).toContain("synth");
      expect(err.message).not.toContain("999-00-1234");
    }
  });

  it("accepts string[] and joins for scanning", () => {
    expect(() =>
      assertNoPhi(["clean line", "DOB: 03/14/1949"], "ctx"),
    ).toThrowError(PhiGuardError);
  });
});

describe('checkForPhi mode "document"', () => {
  /**
   * Policy prose carrying the things a real payer document carries. Every
   * line below is modelled on something measured in an actual source: the
   * department mailbox from Ohio's telehealth billing guidelines, the
   * provider-services line and sample member ID from the UHC Ohio manual,
   * the policy number from the UHC prolonged-services policy, and the
   * "Patient <Titlecase> <Titlecase>" headings that appear in four of the
   * six documents measured.
   */
  const policyPage =
    [
      "Clinical Policy Bulletin: Home Health Nursing Visits.",
      "Effective 01/01/2026. Last review 09/11/2025. Next review 09/11/2026.",
      "PRIOR AUTHORIZATION is required for TELEHEALTH SERVICES billed with",
      "CPT 99341-99350. Policy Number 2025R0003A supersedes the version dated",
      "09/11/2025. Patient Monthly Liability is described in section 4.",
      "Questions: call Provider Services at 800-600-9007 or email",
      "medicaid@medicaid.ohio.gov. Sample member ID: 14A000000001.",
    ].join("\n") + " Additional coverage narrative. ".repeat(60);

  /** A roster: name, birth date, member id and phone on every row. */
  const roster = Array.from({ length: 60 }, (_, i) => {
    const dob = `0${(i % 9) + 1}/1${i % 10}/19${40 + (i % 50)}`;
    return `${i + 1}\tDoe${i}, John${i}\t${dob}\tA1B${200000 + i}C\t919-555-${1000 + i}`;
  }).join("\n");

  it("lets a real payer document through", () => {
    // This is the case that made the whole mode necessary. Under the first
    // cut of document mode, five of six real payer PDFs were refused: the
    // phone numbers, the mailboxes, the policy numbers and the headings
    // were each treated as evidence of a person.
    const r = checkForPhi(policyPage, "document");
    expect(r.hits, JSON.stringify(r.hits)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("reports every shape it allowed instead of dropping them silently", () => {
    const seen = checkForPhi(policyPage, "document").warnings.map((w) => w.pattern);
    for (const p of ["phone", "email", "mrn_like", "dob_slash", "name_trigger"]) {
      expect(seen, p).toContain(p);
    }
  });

  it("names the density in the warning, so the bar can be judged", () => {
    const w = checkForPhi(policyPage, "document").warnings.find(
      (x) => x.pattern === "dob_slash",
    )!;
    expect(w.excerpt).toMatch(/×\d+ distinct \(\d+\.\d\/10k chars\)/);
  });

  it("refuses a record set — identifiers repeating per row", () => {
    const r = checkForPhi(roster, "document");
    expect(r.ok).toBe(false);
    // Not one shape: a roster is dense in several at once, which is the
    // thing that separates it from a document that merely mentions a date.
    expect(r.hits.map((h) => h.pattern).sort()).toEqual(
      expect.arrayContaining(["dob_slash", "mrn_like", "phone"]),
    );
  });

  it("refuses an SSN at any density", () => {
    // The one shape that stays hard: no payer document prints one.
    const r = checkForPhi(`${policyPage}\n123-45-6789`, "document");
    expect(r.ok).toBe(false);
    expect(r.hits.some((h) => h.pattern === "ssn")).toBe(true);
  });

  it("refuses a labelled birth date at any density", () => {
    // What catches a document holding ONE patient, which density cannot.
    for (const label of [
      "DOB: 03/14/1949",
      "Date of birth: 03/14/1949",
      // Across a column boundary, as a table extracts to.
      "Date of birth:\n03/14/1949",
      "Social security number: 123-45-6789",
    ]) {
      expect(checkForPhi(`${policyPage}\n${label}`, "document").ok, label).toBe(false);
    }
  });

  it("does not refuse a manual that merely DISCUSSES those fields", () => {
    // Humana's 81-page Ohio provider manual was refused on this sentence.
    // It is about a PROVIDER's enrollment, carries no number, and is not
    // PHI by any reading. The label has to be followed by a value.
    for (const prose of [
      "Federal Tax ID number or provider Social Security number: Every provider practice has a different structure.",
      "Date of birth: ______________",
      "Include the member DOB: see the claim form instructions.",
    ]) {
      expect(checkForPhi(`${policyPage}\n${prose}`, "document").ok, prose).toBe(true);
    }
  });

  it("KNOWN GAP: one patient, no SSN and no label, passes", () => {
    // Recorded deliberately rather than left to be discovered. Density
    // cannot see a single record, and every shape that would catch this one
    // is a shape provider manuals are built from. Closing it needs a
    // different kind of check, not a lower bar.
    const r = checkForPhi(
      "Discharge summary for Jane Smith, born 1949, seen at home 03/14/2026.",
      "document",
    );
    expect(r.ok).toBe(true);
  });

  it("does not change prompt-mode behaviour", () => {
    // Everything softened above stays hard for the prompts we compose.
    for (const s of [
      "service on 03/14/2026",
      "reach them at (555) 867-5309",
      "email clinician@example.com",
      "Member ID ABC123XY789",
      "patient John Smith",
    ]) {
      expect(checkForPhi(s).ok, s).toBe(false);
    }
    expect(() => assertNoPhi("service on 03/14/2026", "ctx")).toThrowError(
      PhiGuardError,
    );
  });
});
