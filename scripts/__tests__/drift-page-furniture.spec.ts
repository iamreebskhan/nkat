/**
 * A quote split by a page break is not drift.
 *
 * The extractor reads PDFs through Claude, which leaves page furniture out.
 * The drift checker reads them through pdftotext, which emits the running
 * header in reading order — wedged into the middle of any sentence that
 * spans two pages. Both DRIFTED findings on the 2026-08-20 production run
 * were this, on documents no payer had touched:
 *
 *   NC Medicaid CCP 1H     "...which begins  when the RPM is initiated..."
 *   Absolute Total Care    "...revenue code 0651) Routine hospice home..."
 *
 * The fixtures below are those two documents' real text around the break,
 * with their real headers. What makes the rescue safe is not the size of the
 * gap but its CONTENT: a running header repeats on every page, and a revised
 * sentence does not. So every control here — a changed number, a negation,
 * an invented tail, and a gap filled with prose that appears once — has to
 * stay missing, or the check has stopped meaning anything.
 */
import { describe, expect, it } from "vitest";

import { survivesPageFurniture, alnum } from "@/scripts/recheck-source-drift.mjs";

const A = alnum as (s: string) => string;
const survives = survivesPageFurniture as (textAlnum: string, q: string) => boolean;

/** NC Medicaid's running header, as it appears on every page. */
const NC_HEADER =
  "NC Medicaid Medicaid and Health Choice Telehealth, Virtual Communications " +
  "and Remote Patient Monitoring Clinical Coverage Policy No: 1H Amended Date: March 15, 2024";

const NC_QUOTE =
  "May be billed only once for each episode of care, which begins when the RPM " +
  "is initiated and ends with attainment of targeted treatment goals";

/** The document: the sentence interrupted, and the header on other pages. */
const NC_DOC = A(
  `${NC_HEADER} Remote physiologic monitoring treatment management services. ` +
    "May be billed only once for each episode of care, which begins " +
    `${NC_HEADER} when the RPM is initiated and ends with attainment of targeted ` +
    `treatment goals. Providers shall bill their usual and customary charges. ` +
    `${NC_HEADER} Prior approval is not required for these services.`,
);

const ATC_HEADER = "Clinical Policy: Hospice Services Reference Number: CP.MP.54 Page 6 of 17";
const ATC_QUOTE =
  "A. Routine Hospice Home Care (HCPCS T2042 or revenue code 0651) Routine hospice " +
  "home care is medically necessary when less than eight hours of nursing care is required";
const ATC_DOC = A(
  `${ATC_HEADER} Hospice levels of care are defined as follows: ` +
    "A. Routine Hospice Home Care (HCPCS T2042 or revenue code 0651) " +
    `Clinical Policy: Hospice Services Reference Number: CP.MP.54 Page 7 of 17 ` +
    "Routine hospice home care is medically necessary when less than eight hours of " +
    "nursing care is required during a 24-hour period. " +
    `${ATC_HEADER.replace("Page 6", "Page 8")} B. Continuous Home Care. ` +
    `${ATC_HEADER.replace("Page 6", "Page 9")} C. Inpatient Respite Care.`,
);

describe("survivesPageFurniture", () => {
  it("re-joins a quote a running header cut in half", () => {
    expect(NC_DOC.includes(A(NC_QUOTE))).toBe(false); // plain match fails
    expect(survives(NC_DOC, NC_QUOTE)).toBe(true); // ...this one does not
  });

  it("re-joins one whose header carries a counting page number", () => {
    // "Page 6 of 17" becomes "Page 7 of 17" at the break, so the repeat test
    // has to compare with digits removed or the header looks unique.
    expect(ATC_DOC.includes(A(ATC_QUOTE))).toBe(false);
    expect(survives(ATC_DOC, ATC_QUOTE)).toBe(true);
  });

  describe("controls — each must STAY missing", () => {
    it("a changed number", () => {
      expect(survives(ATC_DOC, ATC_QUOTE.replace("eight", "twelve"))).toBe(false);
      expect(survives(ATC_DOC, ATC_QUOTE.replace("T2042", "T2043"))).toBe(false);
    });

    it("a negation", () => {
      expect(
        survives(ATC_DOC, ATC_QUOTE.replace("is medically necessary", "is not medically necessary")),
      ).toBe(false);
      expect(
        survives(NC_DOC, NC_QUOTE.replace("May be billed", "May not be billed")),
      ).toBe(false);
    });

    it("an invented tail", () => {
      expect(
        survives(NC_DOC, `${NC_QUOTE.slice(0, 70)} and requires prior authorization from the plan`),
      ).toBe(false);
    });

    it("a gap filled with prose that occurs only once", () => {
      // The whole safety argument. Same shape as a page break — quote, gap,
      // rest of quote — but the gap is a sentence, not furniture, so the
      // document genuinely no longer says what the quote claims.
      const edited = A(
        "May be billed only once for each episode of care, which begins " +
          "except where the member has exhausted the annual benefit limit " +
          "when the RPM is initiated and ends with attainment of targeted treatment goals",
      );
      expect(survives(edited, NC_QUOTE)).toBe(false);
    });

    it("a quote too short to judge", () => {
      // Below the length floor there is not enough left on either side of the
      // break for "the rest of it resumes nearby" to mean anything.
      expect(survives(NC_DOC, "billed only once")).toBe(false);
    });
  });
});
