/**
 * The content hash must survive markup churn and must NOT survive a
 * change to what the document says.
 *
 * Production accumulated 13 versions of one Aetna clinical policy page in
 * three months — roughly one every six days — because the hash was taken
 * over raw bytes and the page's markup differs on every fetch. Each
 * version is another source_document row and another paid extraction of
 * text that did not change.
 *
 * These cases are the two halves of that: cosmetic differences must
 * collapse, and a real wording change must still be caught. The second
 * half matters more — a hash that is too forgiving silently stops
 * noticing that a payer changed its rules.
 */
import { describe, expect, it } from "vitest";

import { __testing } from "@/lib/features/ingestion/document-ingestion.service";

const { htmlToText, normalizeForHash } = __testing;

/** What the pipeline hashes for an HTML document. */
const basis = (html: string) => normalizeForHash(htmlToText(html));

const POLICY = (extra: string, body = "Prior authorization is required after five visits.") => `
  <html><head><title>Clinical Policy Bulletin 0009</title>${extra}</head>
  <body><h1>Home Health Care</h1><p>${body}</p></body></html>`;

describe("content hash basis", () => {
  it("ignores a rotating timestamp in the markup", () => {
    expect(basis(POLICY('<meta name="generated" content="2026-08-10T04:00:01Z">')))
      .toBe(basis(POLICY('<meta name="generated" content="2026-08-11T04:00:02Z">')));
  });

  it("ignores a session id and a cache-busting asset version", () => {
    expect(basis(POLICY('<script src="/a.js?v=8123"></script><meta name="sid" content="a1b2">')))
      .toBe(basis(POLICY('<script src="/a.js?v=9977"></script><meta name="sid" content="z9y8">')));
  });

  it("ignores reflowed whitespace and indentation", () => {
    const tight = "<html><body><p>Prior authorization is required after five visits.</p></body></html>";
    const loose = `<html>
        <body>
          <p>Prior authorization   is required
             after five visits.</p>
        </body>
      </html>`;
    expect(basis(tight)).toBe(basis(loose));
  });

  // The half that protects the client. If any of these collapse, the
  // pipeline has stopped noticing that a payer changed its rules.
  it("CHANGES when the visit threshold changes", () => {
    expect(basis(POLICY("", "Prior authorization is required after five visits.")))
      .not.toBe(basis(POLICY("", "Prior authorization is required after three visits.")));
  });

  it("CHANGES when a requirement is negated", () => {
    expect(basis(POLICY("", "Prior authorization is required for home visits.")))
      .not.toBe(basis(POLICY("", "Prior authorization is not required for home visits.")));
  });

  it("CHANGES when a code is added to the policy", () => {
    expect(basis(POLICY("", "Prior authorization applies to 99349.")))
      .not.toBe(basis(POLICY("", "Prior authorization applies to 99349, 99350.")));
  });

  it("CHANGES when an effective date moves", () => {
    expect(basis(POLICY("", "Effective 01/01/2026, prior authorization is required.")))
      .not.toBe(basis(POLICY("", "Effective 07/01/2026, prior authorization is required.")));
  });
});
