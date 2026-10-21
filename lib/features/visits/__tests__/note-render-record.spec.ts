/**
 * Renderers shared by the note preview, the audit packet and the patient
 * record export: addenda (audit R15), the attestation line (audit R32), and
 * the note body, vitals and legacy notes (audit R28).
 */
import { describe, expect, it } from "vitest";

import {
  renderAddendaHtml,
  renderAttestationLine,
  renderLegacyNoteHtml,
  renderNoteBodyHtml,
  renderVitalsRows,
} from "../note-render";

/**
 * Signed times are on the practice's clock (org.timezone), beside a date of
 * visit that already is. They printed UTC: on localhost Shirley Tanaka's note
 * read "signed … on 2026-09-23 22:10 UTC" for 6:10 pm in Ohio, and after 8 pm
 * such a time falls on the next day.
 */
const OHIO = "America/New_York";

describe("renderAddendaHtml", () => {
  const a = {
    body: "Late entry <script>x</script>",
    author_name: "Dr <b>Rao</b>",
    author_credential: "MD",
    signed_at: new Date("2026-09-14T10:05:00Z"),
  };

  it("prints each addendum with its author, credential and the practice's time, escaped", () => {
    const html = renderAddendaHtml([a], OHIO);
    expect(html).toContain("<h2>Addenda</h2>");
    expect(html).toContain("Dr &lt;b&gt;Rao&lt;/b&gt;, MD");
    expect(html).toContain("2026-09-14 06:05 EDT");
    expect(html).not.toContain("UTC");
    expect(html).toContain("Late entry &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("dates an Ohio evening addendum on its Ohio day", () => {
    // 01:30 UTC on the 15th is 9:30 pm on the 14th in Ohio.
    const late = { ...a, signed_at: new Date("2026-09-15T01:30:00Z") };
    expect(renderAddendaHtml([late], OHIO)).toContain("2026-09-14 21:30 EDT");
  });

  it("renders nothing when there are none", () => {
    expect(renderAddendaHtml([], OHIO)).toBe("");
  });
});

describe("renderAttestationLine", () => {
  const base = {
    signerName: "Test Admin",
    signerCredential: "NP",
    signedAt: new Date("2026-09-14T10:00:00Z"),
    signedByUserId: "u1",
    clinicianUserId: "u1",
    timeZone: OHIO,
  };

  it("names the signer, credential and time, on the practice's clock", () => {
    expect(renderAttestationLine(base)).toContain(
      "Electronically signed by <strong>Test Admin</strong>, NP on 2026-09-14 06:00 EDT",
    );
  });

  it("says which clock in winter too, and in another practice zone", () => {
    expect(renderAttestationLine({ ...base, signedAt: new Date("2026-01-14T15:00:00Z") })).toContain(
      "on 2026-01-14 10:00 EST",
    );
    expect(renderAttestationLine({ ...base, timeZone: "America/Chicago" })).toContain(
      "on 2026-09-14 05:00 CDT",
    );
  });

  it("dates an Ohio evening signature on its Ohio day, not the UTC one", () => {
    // Shirley Tanaka's visit was signed at 22:10 UTC on 23 Sep: 6:10 pm in
    // Ohio. One signed at 01:30 UTC on the 24th was 9:30 pm on the 23rd.
    expect(renderAttestationLine({ ...base, signedAt: new Date("2026-09-23T22:10:35Z") })).toContain(
      "on 2026-09-23 18:10 EDT",
    );
    expect(renderAttestationLine({ ...base, signedAt: new Date("2026-09-24T01:30:00Z") })).toContain(
      "on 2026-09-23 21:30 EDT",
    );
  });

  it("flags a signer who is not the clinician of record — by id, not by name", () => {
    // Two different people with the same display name used to pass the old name check.
    expect(renderAttestationLine({ ...base, clinicianUserId: "u2" })).toContain(
      "not the clinician of record",
    );
    expect(renderAttestationLine(base)).not.toContain("not the clinician of record");
  });

  it("says when no credential was recorded", () => {
    expect(renderAttestationLine({ ...base, signerCredential: null })).toContain("credential not recorded");
  });

  it("says an unsigned visit is not signed", () => {
    expect(renderAttestationLine({ ...base, signedAt: null })).toContain("Not signed.");
  });

  it("escapes the signer's name", () => {
    expect(renderAttestationLine({ ...base, signerName: "<img>" })).toContain("&lt;img&gt;");
  });
});

describe("renderLegacyNoteHtml", () => {
  it("renders a legacy TipTap document as prose, never as raw JSON", () => {
    const html = renderLegacyNoteHtml(
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Seen at home."}]}]}',
    );
    expect(html).toContain("<p>Seen at home.</p>");
    expect(html).not.toContain('{"type":"doc"');
  });

  it("escapes legacy plain text", () => {
    expect(renderLegacyNoteHtml("pain <3/10>")).toContain("pain &lt;3/10&gt;");
  });

  it("renders nothing for an empty note", () => {
    expect(renderLegacyNoteHtml(null)).toBe("");
    expect(renderLegacyNoteHtml("  ")).toBe("");
  });
});

describe("renderVitalsRows", () => {
  it("prints readings in the units the clinician entered them in", () => {
    const html = renderVitalsRows({ weight_kg: "58.06", bp_systolic: 120, bp_diastolic: 80 });
    expect(html).toContain("lb");
    expect(html).toContain("120/80");
    expect(html).not.toContain("58.06");
  });

  it("renders nothing without readings", () => {
    expect(renderVitalsRows(null)).toBe("");
  });
});

describe("renderNoteBodyHtml", () => {
  it("marks an empty section 'Not documented' and flags an unedited carry-forward", () => {
    const html = renderNoteBodyHtml(
      [
        { label: "HPI", kind: "prose", content: {}, is_empty: true, carried_unchanged: false },
        {
          label: "Plan", kind: "list", content: { items: ["Rotate to fentanyl"] },
          is_empty: false, carried_unchanged: true,
        },
      ],
      "",
    );
    expect(html).toContain("<h3>HPI</h3><p class=\"empty\">Not documented.</p>");
    expect(html).toContain("carried forward, unedited");
    expect(html).toContain("<li>Rotate to fentanyl</li>");
  });
});
