/**
 * The audit packet's two testable halves: rendering a stored note back to
 * HTML, and the note-against-bill reconciliation.
 *
 * The reconciliation is the part that matters most. Mark Hendrix described the
 * audit as taking "the note and the superbill and compar[ing] them and mak[ing]
 * sure that they match", and said the failure mode is agencies who break the
 * rules "and don't realize it". A packet that quietly omitted a mismatch would
 * be worse than no packet, so every disagreement has to surface.
 */
import { describe, expect, it } from "vitest";

import { renderProse, renderSectionHtml, proseToText, escapeHtml } from "../note-render";
import { reconcile, type PacketFinding } from "../audit-packet.service";

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (text: string, marks?: { type: string }[]) => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});

describe("renderProse", () => {
  it("renders paragraphs", () => {
    expect(renderProse(doc(para("Seen at home.")))).toBe("<p>Seen at home.</p>");
  });

  it("escapes clinician-entered HTML rather than emitting it", () => {
    // A note goes into a PDF via a real browser. Unescaped input here would be
    // script injection into a document that gets sent to a payer.
    const out = renderProse(doc(para('<img src=x onerror="alert(1)">')));
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("keeps an empty paragraph as a blank line", () => {
    expect(renderProse(doc({ type: "paragraph" }))).toBe("<p>&nbsp;</p>");
  });

  it("renders marks", () => {
    expect(renderProse(doc(para("urgent", [{ type: "bold" }])))).toBe(
      "<p><strong>urgent</strong></p>",
    );
    expect(renderProse(doc(para("q.i.d.", [{ type: "italic" }])))).toBe(
      "<p><em>q.i.d.</em></p>",
    );
  });

  it("renders headings, clamping the level into range", () => {
    expect(renderProse(doc({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Plan" }] })))
      .toBe("<h3>Plan</h3>");
    expect(renderProse(doc({ type: "heading", attrs: { level: 99 }, content: [{ type: "text", text: "Plan" }] })))
      .toBe("<h6>Plan</h6>");
  });

  it("renders nested lists", () => {
    const out = renderProse(
      doc({
        type: "bulletList",
        content: [{ type: "listItem", content: [para("Oxycodone 10mg")] }],
      }),
    );
    expect(out).toBe("<ul><li><p>Oxycodone 10mg</p></li></ul>");
  });

  it("keeps an ordered list's start attribute when it is not 1", () => {
    const out = renderProse(
      doc({ type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [para("Third")] }] }),
    );
    expect(out).toContain('<ol start="3">');
  });

  it("keeps text nested inside an unrecognised node rather than dropping it", () => {
    // Dropping clinical text because a node type is unfamiliar would silently
    // shorten the record an auditor reads.
    const out = renderProse(doc({ type: "someFutureExtension", content: [para("Do not lose me.")] }));
    expect(out).toContain("Do not lose me.");
  });

  it("returns empty for null and non-objects", () => {
    expect(renderProse(null)).toBe("");
    expect(renderProse("a string")).toBe("");
  });
});

describe("renderSectionHtml", () => {
  it("renders a list section, skipping blank items", () => {
    expect(renderSectionHtml("list", { items: ["Senna 2 BD", "  ", "MiraLAX 17g"] })).toBe(
      "<ul><li>Senna 2 BD</li><li>MiraLAX 17g</li></ul>",
    );
  });

  it("escapes list items too", () => {
    expect(renderSectionHtml("list", { items: ["<b>bold</b>"] })).toContain("&lt;b&gt;");
  });

  it("renders nothing for a vitals section — those come from visit_vitals", () => {
    expect(renderSectionHtml("vitals", { weightKg: 61 })).toBe("");
  });
});

describe("proseToText", () => {
  it("flattens a document to readable text", () => {
    expect(proseToText(doc(para("One."), para("Two.")))).toBe("One.\nTwo.");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

// ---------------------------------------------------------------------------

const base = {
  visit: {
    id: "v", status: "pending_billing", dos: new Date("2026-09-09"),
    total_minutes: 45, acp_minutes: 0, is_telehealth: false, telehealth_modality: null,
    cpt_codes_assigned: ["99348"], icd10_codes: ["C34.90"], modifiers: [],
    signed_at: new Date(), visit_type_label: "Established patient — home",
    place_of_service_code: "12",
    signer_name: "A Nurse", signer_email: "a@x.test", clinician_name: "A Nurse",
  },
  patient: { id: "p", first_name: "Stephen", last_name: "Singleton", date_of_birth: new Date("1936-01-19") },
  sections: [
    { label: "History of present illness", kind: "prose" as const, content: {}, is_empty: false, carried_unchanged: false },
    { label: "Assessment and plan", kind: "prose" as const, content: {}, is_empty: false, carried_unchanged: false },
  ],
  vitals: null,
  superbill: {
    id: "s", status: "draft", cpt_codes: ["99348"], icd10_codes: ["C34.90"], modifiers: [],
    billed_amount_cents: BigInt(10179), provider_npi: "1234567890", provider_name: "A Nurse",
    billing_npi: "1497758544", payer_name: "CareSource Ohio", member_id_snapshot: "M1",
    place_of_service_code: "12",
  },
  orgName: "Design Partner",
  // org.timezone (0107): the addenda's "latest on" day is read in it.
  timeZone: "America/New_York",
  primary: "#0d9488",
};
// PacketData is internal to the service; the shape above is what it reads.
const run = (over: Record<string, unknown> = {}): PacketFinding[] =>
  reconcile({ ...base, ...over } as never);

const find = (fs: PacketFinding[], label: string) => fs.find((f) => f.label === label);

describe("reconcile", () => {
  it("reports agreement when the note and the bill carry the same codes", () => {
    const f = find(run(), "Procedure codes agree");
    expect(f?.severity).toBe("match");
  });

  it("flags a bill edited away from the attested note", () => {
    const f = run({
      superbill: { ...base.superbill, cpt_codes: ["99350"] },
    });
    const m = find(f, "Procedure codes differ");
    expect(m?.severity).toBe("mismatch");
    expect(m?.detail).toContain("99350");
    expect(m?.detail).toContain("99348");
  });

  it("ignores ordering and duplicates when comparing codes", () => {
    const f = run({
      visit: { ...base.visit, cpt_codes_assigned: ["99348", "99348"] },
      superbill: { ...base.superbill, cpt_codes: ["99348"] },
    });
    expect(find(f, "Procedure codes agree")?.severity).toBe("match");
  });

  it("CONTROL: flags a bill whose add-on units differ from the signed visit's, naming both counts", () => {
    // The codes agree as a set; the claim bills G0318 twice where the note
    // supports three increments. The comparison used to see codes only, so
    // this read as agreement.
    const f = run({
      visit: { ...base.visit, cpt_codes_assigned: ["99350", "G0318"], cpt_units: { G0318: 3 } },
      superbill: { ...base.superbill, cpt_codes: ["99350", "G0318"], cpt_units: { G0318: 2 } },
    });
    expect(find(f, "Procedure codes agree")).toBeUndefined();
    const m = find(f, "Procedure codes differ");
    expect(m?.severity).toBe("mismatch");
    expect(m?.detail).toContain("G0318 ×2");
    expect(m?.detail).toContain("G0318 ×3");
  });

  it("agrees when neither side carries units, as every row before 0106 does", () => {
    const f = run({
      visit: { ...base.visit, cpt_codes_assigned: ["99350", "G0318"] },
      superbill: { ...base.superbill, cpt_codes: ["G0318", "99350"], cpt_units: {} },
    });
    expect(find(f, "Procedure codes agree")?.severity).toBe("match");
  });

  it("says so when a signed visit has no superbill, and offers to create one", () => {
    const f = run({ superbill: null, visit: { ...base.visit, status: "pending_billing" } });
    const m = find(f, "No superbill");
    expect(m?.severity).toBe("attention");
    expect(m?.action).toBe("create_superbill");
  });

  it("does not tell a clinician an unsigned visit was signed, and offers no bill action", () => {
    // The reconciliation now runs before signing. The old single wording said
    // "this visit has been signed" about visits that had not been — seen live
    // on an in-progress visit.
    const f = run({ superbill: null, visit: { ...base.visit, status: "in_progress" } });
    expect(find(f, "No superbill")).toBeUndefined();
    const m = find(f, "No bill yet");
    expect(m?.severity).toBe("attention");
    expect(m?.detail).not.toMatch(/has been signed/);
    expect(m?.action).toBeUndefined();
  });

  it("attaches the create action to the missing-bill finding and nothing else", () => {
    const f = run({
      superbill: null,
      visit: { ...base.visit, status: "billed", is_telehealth: true },
    });
    expect(f.filter((x) => x.action === "create_superbill").map((x) => x.label)).toEqual([
      "No superbill",
    ]);
  });

  it("says a Not billed visit needs no bill, and offers no create action (audit R18)", () => {
    // Offering to create one would lead only to buildDraftFromVisit's refusal.
    const f = run({
      superbill: null,
      visit: { ...base.visit, status: "documented", coding_basis: "non_billable" },
    });
    expect(find(f, "No superbill")).toBeUndefined();
    expect(find(f, "Not billed")?.severity).toBe("match");
    expect(f.some((x) => x.action === "create_superbill")).toBe(false);
  });

  it("CONTROL — a signed billable visit with no bill is still flagged, with the action", () => {
    const f = run({
      superbill: null,
      visit: { ...base.visit, status: "documented", coding_basis: "established_patient_home" },
    });
    expect(find(f, "No superbill")?.action).toBe("create_superbill");
    expect(find(f, "Not billed")).toBeUndefined();
  });

  it("does not call an empty unsigned draft a defective signed note", () => {
    // The reconciliation runs before signing now. An empty draft is unfinished
    // work, not an attested note with nothing in it — the old wording said
    // "the signed note contains no documentation" about in-progress visits.
    const f = run({ sections: [], visit: { ...base.visit, status: "in_progress" } });
    const m = find(f, "Note content");
    expect(m?.severity).toBe("attention");
    expect(m?.detail).toBe("Nothing has been written on this note yet.");
    expect(m?.detail).not.toMatch(/signed/);
  });

  it("still flags a signed note with nothing in it as a mismatch", () => {
    const f = run({ sections: [], visit: { ...base.visit, status: "documented" } });
    const m = find(f, "Note content");
    expect(m?.severity).toBe("mismatch");
    expect(m?.detail).toBe("The signed note contains no documentation at all.");
  });

  it("flags a claim with no diagnosis", () => {
    const f = run({ superbill: { ...base.superbill, icd10_codes: [] } });
    expect(find(f, "No diagnosis on the bill")?.severity).toBe("mismatch");
  });

  it("flags a blank rendering-provider NPI", () => {
    const f = run({ superbill: { ...base.superbill, provider_npi: "" } });
    expect(find(f, "No rendering-provider NPI")?.severity).toBe("mismatch");
  });

  it("flags the organization's NPI standing in as rendering provider (audit R40)", () => {
    const f = run({ superbill: { ...base.superbill, provider_npi: "1497758544" } });
    expect(find(f, "Rendering NPI is the organization's")?.severity).toBe("attention");
    expect(find(f, "No rendering-provider NPI")).toBeUndefined();
  });

  it("is quiet when the bill names the clinician's own NPI", () => {
    expect(find(run(), "Rendering NPI is the organization's")).toBeUndefined();
  });

  it("does not guess on bills saved before the billing NPI was recorded", () => {
    const f = run({ superbill: { ...base.superbill, billing_npi: null } });
    expect(find(f, "Rendering NPI is the organization's")).toBeUndefined();
  });

  it("flags a signed note with nothing in it", () => {
    const f = run({
      sections: base.sections.map((s) => ({ ...s, is_empty: true })),
    });
    expect(find(f, "Note content")?.severity).toBe("mismatch");
  });

  it("flags sections carried forward and never edited", () => {
    const f = run({
      sections: [{ ...base.sections[0], carried_unchanged: true }, base.sections[1]],
    });
    const c = find(f, "Carried forward unchanged");
    expect(c?.severity).toBe("attention");
    expect(c?.detail).toContain("History of present illness");
  });

  it("flags a telehealth visit billed without modifier 95 or 93", () => {
    const f = run({ visit: { ...base.visit, is_telehealth: true } });
    expect(find(f, "Telehealth modifier")?.severity).toBe("mismatch");
  });

  it("accepts a telehealth visit that carries modifier 95", () => {
    const f = run({
      visit: { ...base.visit, is_telehealth: true },
      superbill: { ...base.superbill, modifiers: ["95"] },
    });
    expect(find(f, "Telehealth modifier")?.severity).toBe("match");
  });

  it("never reports a modifier match from the visit's own record", () => {
    // The bug: `sb?.modifiers ?? d.visit.modifiers` meant a visit with no
    // superbill was checked against ITSELF and reported "billed with modifier
    // 95" when nothing had been billed. This document exists to compare the
    // note against the bill; comparing it against itself always agrees.
    const f = run({
      visit: { ...base.visit, is_telehealth: true, modifiers: ["95"] },
      superbill: null,
    });
    const m = find(f, "Telehealth modifier");
    expect(m?.severity).toBe("attention");
    expect(m?.severity).not.toBe("match");
    expect(m?.detail).toContain("no superbill yet");
  });

  it("still reports a mismatch when the bill carries the wrong modifier", () => {
    const f = run({
      visit: { ...base.visit, is_telehealth: true, modifiers: ["95"] },
      superbill: { ...base.superbill, modifiers: ["25"] },
    });
    expect(find(f, "Telehealth modifier")?.severity).toBe("mismatch");
  });

  it("accepts modifier 93 for an audio-only telehealth visit", () => {
    const f = run({
      visit: { ...base.visit, is_telehealth: true },
      superbill: { ...base.superbill, modifiers: ["93"] },
    });
    const m = find(f, "Telehealth modifier");
    expect(m?.severity).toBe("match");
    expect(m?.detail).toContain("93");
  });

  it("flags a visit with no time recorded", () => {
    const f = run({ visit: { ...base.visit, total_minutes: null } });
    expect(find(f, "No time recorded")?.severity).toBe("attention");
  });

  it("reports ACP minutes separately when present", () => {
    const f = run({ visit: { ...base.visit, acp_minutes: 20 } });
    expect(find(f, "Time documented")?.detail).toContain("20 minutes advance care planning");
  });
});

describe("reconcile — place of service (audit R23)", () => {
  it("agrees when the bill carries what the visit recorded", () => {
    expect(find(run(), "Place of service agrees")?.severity).toBe("match");
  });

  it("flags a bill whose place of service differs from the visit's, naming both", () => {
    const f = run({ superbill: { ...base.superbill, place_of_service_code: "31" } });
    const m = find(f, "Place of service differs");
    expect(m?.severity).toBe("mismatch");
    expect(m?.detail).toContain("31 · Skilled nursing facility");
    expect(m?.detail).toContain("12 · Home");
  });

  it("says so when the visit never recorded where it took place", () => {
    const f = run({ visit: { ...base.visit, place_of_service_code: null } });
    expect(find(f, "Place of service not recorded on the visit")?.severity).toBe("attention");
  });

  it("says nothing about place of service when there is no bill", () => {
    const f = run({ superbill: null });
    expect(f.some((x) => x.label.startsWith("Place of service"))).toBe(false);
  });
});

describe("reconcile — addenda (audit R15)", () => {
  it("says when corrections were recorded after signing", () => {
    const f = run({
      addenda: [
        { body: "Late entry.", author_name: "Test Admin", author_credential: "NP", signed_at: new Date("2026-09-12T10:00:00Z") },
        { body: "Correction.", author_name: "Test Admin", author_credential: "NP", signed_at: new Date("2026-09-13T10:00:00Z") },
      ],
    });
    const a = find(f, "Addenda");
    expect(a?.severity).toBe("attention");
    expect(a?.detail).toContain("2 addenda recorded after signing, the latest on 2026-09-13");
  });

  it("says nothing about addenda when there are none", () => {
    expect(find(run(), "Addenda")).toBeUndefined();
  });
});
