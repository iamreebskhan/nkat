/**
 * The guard that decides whether a crawled document may replace a live rule.
 *
 * Extracted from the write path so a dry run can ask the same question
 * without writing. That sharing is the point of the test: if these two ever
 * diverge, the dry-run report becomes confidently wrong about whether your
 * seeded rules survive, which is worse than having no report.
 *
 * The rule it encodes was paid for. A test fixture registered against a real
 * payer displaced ten Federal-Register-cited Medicare rules, because nothing
 * asked whether the replacement came from the same publisher as the answer it
 * was replacing.
 */
import { describe, expect, it } from "vitest";

import { displacementRefusal } from "@/lib/features/ingestion/document-ingestion.service";

const CMS = "https://www.federalregister.gov/documents/2025/11/05/2025-19787/medicare";
const AETNA = "https://www.aetna.com/cpb/medical/data/1_99/0009.html";

describe("displacementRefusal", () => {
  it("allows a key nothing is answering", () => {
    expect(displacementRefusal(null, AETNA)).toBeNull();
  });

  it("allows a newer edition from the same publisher", () => {
    expect(
      displacementRefusal(
        { url: "https://www.aetna.com/cpb/medical/data/1_99/0009.html", created_by: "extract:round3" },
        "https://www.aetna.com/cpb/medical/data/200_299/0201.html",
      ),
    ).toBeNull();
  });

  it("refuses a different publisher, naming both hosts", () => {
    const r = displacementRefusal({ url: CMS, created_by: "extract:round3" }, AETNA);
    expect(r).toContain("federalregister.gov");
    expect(r).toContain("aetna.com");
  });

  it("refuses a person-authored rule even from the same host", () => {
    // A crawler never overwrites a human, whatever it is citing.
    const r = displacementRefusal(
      { url: AETNA, created_by: "hamda@theaura.agency" },
      AETNA,
    );
    expect(r).toContain("person-authored");
    expect(r).toContain("hamda@theaura.agency");
  });

  it("treats the person check as stronger than the host check", () => {
    // Both conditions fail; the message must be the one that explains why a
    // same-host replacement was still refused.
    const r = displacementRefusal({ url: CMS, created_by: "a@b.com" }, AETNA);
    expect(r).toContain("person-authored");
  });

  it("treats subdomains of one organisation as one publisher", () => {
    // This test asserted the opposite when it was written, and the assertion
    // was wrong. Aetna serves the same office manual from www.aetna.com and
    // es.aetna.com (its Spanish site), and 75 live rules cite the latter — so
    // a fresh read of the canonical host was refused with "incumbent cites
    // es.aetna.com, this document is aetna.com". Aetna forbidden from
    // updating Aetna. A dry run of the office manual surfaced it as a real
    // refusal, not a hypothetical.
    expect(
      displacementRefusal(
        { url: "https://es.aetna.com/content/dam/aetna/office_manual_hcp.pdf", created_by: "extract:x" },
        "https://www.aetna.com/content/dam/aetna/office_manual_hcp.pdf",
      ),
    ).toBeNull();
    // Anthem has the same shape.
    expect(
      displacementRefusal(
        { url: "https://providernews.anthem.com/ohio/articles/x", created_by: "extract:x" },
        "https://files.providernews.anthem.com/4489/y.pdf",
      ),
    ).toBeNull();
  });

  it("still separates genuinely different publishers of the same rule", () => {
    // The distinction the guard was built for. govinfo.gov and
    // federalregister.gov both carry the CY2026 final rule; cms.gov is a
    // third. Merging subdomains must not merge these.
    for (const [a, b] of [
      ["https://www.govinfo.gov/content/pkg/FR-2025-11-05/pdf/2025-19787.pdf", CMS],
      ["https://www.cms.gov/files/zip/rvu26c.zip", CMS],
    ] as const) {
      expect(displacementRefusal({ url: a, created_by: "crawler:x" }, b)).toBeTruthy();
    }
  });
});
