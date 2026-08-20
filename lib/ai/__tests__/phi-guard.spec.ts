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
  /** Policy prose: a handful of dates, each repeated, in a lot of text. */
  const policyPage = [
    "Clinical Policy Bulletin: Home Health Nursing Visits.",
    "Effective 01/01/2026. Last review 09/11/2025. Next review 09/11/2026.",
    "PRIOR AUTHORIZATION is required for TELEHEALTH SERVICES billed with",
    "CPT 99341-99350. Aetna considers home visits medically necessary when",
    "the criteria below are met. This policy supersedes the version dated",
    "09/11/2025 and applies to claims with dates of service on or after",
    "01/01/2026.",
  ].join("\n") + " Additional coverage narrative. ".repeat(60);

  /** A roster: one distinct date per row, in very little text. */
  const roster = Array.from(
    { length: 40 },
    (_, i) => `Row ${i + 1}\t0${(i % 9) + 1}/1${i % 10}/19${40 + i}\thome visit`,
  ).join("\n");

  it("lets a real payer policy page through", () => {
    const r = checkForPhi(policyPage, "document");
    expect(r.hits, JSON.stringify(r.hits)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("reports the dates it allowed instead of dropping them silently", () => {
    const r = checkForPhi(policyPage, "document");
    expect(r.warnings.some((w) => w.pattern === "dob_slash")).toBe(true);
  });

  it("still refuses a record set — many distinct dates in little text", () => {
    const r = checkForPhi(roster, "document");
    expect(r.ok).toBe(false);
    expect(r.hits.some((h) => h.pattern === "dob_slash")).toBe(true);
  });

  it("still refuses a labelled birth date at any density", () => {
    // The keyword marker is a hard trigger in both modes: one occurrence
    // is evidence on its own, unlike a bare date.
    const r = checkForPhi(`${policyPage}\nDOB: 03/14/1949`, "document");
    expect(r.ok).toBe(false);
  });

  it("still refuses every identifier that names a person", () => {
    for (const s of [
      "SSN 123-45-6789",
      "reach them at (555) 867-5309",
      "email clinician@example.com",
      "Member ID ABC123XY789",
      "patient John Smith",
    ]) {
      expect(checkForPhi(`${policyPage}\n${s}`, "document").ok, s).toBe(false);
    }
  });

  it("does not change prompt-mode behaviour — a lone date still refuses", () => {
    expect(checkForPhi("service on 03/14/2026").ok).toBe(false);
    expect(() => assertNoPhi("service on 03/14/2026", "ctx")).toThrowError(
      PhiGuardError,
    );
  });
});
