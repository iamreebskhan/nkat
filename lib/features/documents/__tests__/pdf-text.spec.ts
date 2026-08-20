/**
 * The PDF text layer exists for ONE reason: so the PHI guard has something
 * to read before a payer PDF goes to Anthropic. Roughly 20 of the 25
 * registered sources are PDFs, and every one of them used to be sent
 * unscreened because the guard only ever ran on HTML.
 *
 * So the two cases that matter here are "it read the text" and "it could
 * not, and said so" — because the caller turns the second into a refusal,
 * and a parse failure that quietly returned "" would read as a clean scan.
 */
import { describe, expect, it } from "vitest";

import { extractPdfText } from "@/lib/features/documents/pdf-text";

/** A minimal, hand-written PDF with one uncompressed text object. */
const ONE_PAGE_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 78>>stream
BT /F1 12 Tf 20 100 Td (Prior authorization is required after five visits.) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`,
  "latin1",
);

describe("extractPdfText", () => {
  it("reads the text layer", async () => {
    const r = await extractPdfText(ONE_PAGE_PDF);
    expect(r.complete).toBe(true);
    expect(r.pages).toBe(1);
    expect(r.text).toContain("Prior authorization is required after five visits.");
    expect(r.reason).toBeNull();
  });

  it("reports a file it cannot parse instead of returning empty text", async () => {
    // The dangerous failure: "" looks exactly like a clean scan of a
    // document containing no PHI. complete:false is what stops the send.
    const r = await extractPdfText(Buffer.from("not a pdf at all", "utf8"));
    expect(r.complete).toBe(false);
    expect(r.text).toBe("");
    expect(r.reason).toMatch(/could not parse/i);
  });

  it("reports a timeout as incomplete, not as a finished read", async () => {
    const r = await extractPdfText(ONE_PAGE_PDF, { deadlineMs: -1 });
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/timed out/);
  });
});
