/**
 * Pure-function smoke for the parts of document-ingestion.service.ts
 * that don't touch the DB or Claude. We import private helpers via a
 * named re-export shim — but since the service keeps `htmlToText`
 * private, this spec ALSO acts as a regression check on the
 * extractor's exported chunkText (already tested in
 * documents/extractor.spec.ts) by walking a realistic policy excerpt
 * through chunkText with the same defaults the service uses.
 */
import { describe, expect, it } from "vitest";

import { chunkText } from "@/lib/features/documents/extractor";

describe("ingestion: chunkText on a realistic policy excerpt", () => {
  it("keeps related paragraphs together when under the cap", () => {
    const policy = `Section 4. Home visit code 99349 is COVERED.

Section 5. Prior authorization is NOT required for 99349.

Section 6. Telehealth delivery is permitted via audio-video with modifier 95.`;
    const chunks = chunkText(policy);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("99349");
    expect(chunks[0]).toContain("modifier 95");
  });

  it("hard-wraps an oversized single paragraph for embedding budget", () => {
    const huge = "x".repeat(5000);
    const chunks = chunkText(huge, { maxChars: 1200, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 1200)).toBe(true);
  });

  it("returns empty for whitespace-only input (don't ingest noise)", () => {
    expect(chunkText("   \n\n  \n")).toEqual([]);
  });
});
