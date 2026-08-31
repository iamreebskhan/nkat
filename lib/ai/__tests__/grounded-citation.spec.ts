/**
 * A synthesised answer may only cite something that is actually in front of it.
 *
 * The check above this one — "did the model format a citation" — was called
 * the hallucination floor, and it is not one. A model that invents a
 * plausible document name and a plausible quote clears it completely.
 *
 * Which is what happened. Aetna / OH / 99213, on production:
 *
 *   answer   "CPT 99213 is covered for established-patient outpatient E/M
 *             ... with no prior authorization required."
 *   source   "Aetna Ohio supplemental coverage note 2026"
 *   quote    "CPT 99213 is COVERED for established-patient outpatient E/M
 *             when delivered in the office..."
 *
 * No document of that name exists in the corpus. Aetna has no stored rule for
 * 99213 precisely because a seed enumerated all 919 of its live medical policy
 * bulletins and found no code-level determination — so the library's
 * considered position is "Aetna does not publish this", and the synthesiser
 * was overruling it with a source it made up, for a biller to act on.
 */
import { describe, expect, it } from "vitest";

import { parseGroundedCitation } from "@/lib/ai/anthropic.client";

const CONTEXT = [
  "Ohio Administrative Code 5160-1-60 Appendix DD, revised 01/01/2026.",
  "99349 | Home visit, established patient | 01/01/2024 | status 2 | payment 70.13",
  "Prior authorization is not required for home visit evaluation and management codes.",
].join("\n");

const reply = (quote: string, doc = "Ohio Medicaid Appendix DD", date = "2026") =>
  `Home visits are payable.\n\nSource: ${doc} (${date}) — "${quote}"`;

describe("parseGroundedCitation", () => {
  it("accepts a quote that is in the context", () => {
    const r = parseGroundedCitation(
      reply("Prior authorization is not required for home visit evaluation and management codes."),
      CONTEXT,
    );
    expect(r.refused).toBe(false);
    expect(r.citation?.documentName).toBe("Ohio Medicaid Appendix DD");
    expect(r.citation?.verbatimQuote).toMatch(/^Prior authorization is not required/);
  });

  it("forgives whitespace and case, like the extractor does", () => {
    const r = parseGroundedCitation(
      reply("prior authorization   is NOT required for home visit\nevaluation and management codes."),
      CONTEXT,
    );
    expect(r.refused).toBe(false);
  });

  it("REFUSES the fabricated Aetna citation that prompted this", () => {
    const r = parseGroundedCitation(
      reply(
        "CPT 99213 is COVERED for established-patient outpatient E/M when delivered in the office.",
        "Aetna Ohio supplemental coverage note 2026",
      ),
      CONTEXT,
    );
    expect(r.refused).toBe(true);
    expect(r.citation).toBeNull();
  });

  it("refuses a quote that only PARAPHRASES the context", () => {
    // The nearest miss, and the likeliest one: the substance is right and the
    // words are the model's. A paraphrase presented as a verbatim quote is
    // still a fabricated quote.
    const r = parseGroundedCitation(
      reply("No prior auth is needed for home visit E/M codes."),
      CONTEXT,
    );
    expect(r.refused).toBe(true);
  });

  it("refuses a quote too short to mean anything", () => {
    expect(parseGroundedCitation(reply("payment"), CONTEXT).refused).toBe(true);
  });

  it("still passes the refusal sentinels straight through", () => {
    for (const s of ["NO_RULE_FOUND", "REFUSED_PHI_DETECTED"]) {
      const r = parseGroundedCitation(s, CONTEXT);
      expect(r.refused).toBe(true);
      expect(r.citation).toBeNull();
      expect(r.answer).toBe(s);
    }
  });

  it("still refuses a reply carrying no citation at all", () => {
    const r = parseGroundedCitation("99213 is covered, trust me.", CONTEXT);
    expect(r.refused).toBe(true);
    expect(r.citation).toBeNull();
  });

  it("checks the structured rule too, not only the document chunks", () => {
    // The caller passes both; a quote lifted from the stored rule is grounded.
    const r = parseGroundedCitation(
      reply("status 2 | payment 70.13"),
      "99349 | Home visit, established patient | 01/01/2024 | status 2 | payment 70.13",
    );
    expect(r.refused).toBe(false);
  });
});
