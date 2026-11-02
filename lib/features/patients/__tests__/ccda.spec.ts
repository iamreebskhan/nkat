/**
 * @vitest-environment jsdom
 */
/**
 * The C-CDA R2.1 CCD. The document is parsed by a real XML parser, and read the
 * way a receiver reads it: by template, code system and code. Pure.
 */
import { describe, expect, it } from "vitest";

import { buildCcd, ccdVitals, type CcdInput } from "../ccda";
import { DECLINED, ethnicityText, languageText, raceText, RaceSchema } from "../uscdi";

const NOW = new Date("2026-10-31T15:30:00Z");

const input = (over: Partial<CcdInput> = {}): CcdInput => ({
  documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  now: NOW,
  org: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Test Palliative", phone: "6145551234", line1: "2 Main St", city: "Columbus", state: "OH", zip: "43004", npi: "1234567893" },
  author: { name: "Helen Okafor", npi: "1679576722" },
  patient: {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", firstName: "Ruth", lastName: "Testcase", dateOfBirth: "1941-05-12", sex: "F",
    addressLine1: "1 Main St", city: "Columbus", state: "OH", zip: "43004", phone: "(614) 555-0100",
    raceCodes: ["2106-3", "2054-5"], ethnicity: "2186-5", language: "es",
  },
  allergies: [{ id: "a1", substance: "Penicillin", kind: "drug", reaction: "Hives", severity: "moderate", status: "active", rxnormCui: "7980", recordedOn: "2026-01-02" }],
  noKnownAllergies: false,
  medications: [
    { id: "m1", name: "Lisinopril 10 MG Oral Tablet", dose: "10 mg", route: "PO", frequency: "Daily", status: "active", startedOn: "2026-01-02", stoppedOn: null, rxnormCui: "314076" },
    { id: "m2", name: "Grandma's tea", dose: null, route: null, frequency: null, status: "stopped", startedOn: null, stoppedOn: "2026-03-01", rxnormCui: null },
  ],
  problems: [{ id: "p1", icd10: "C34.90", description: "Lung cancer", status: "active", onsetOn: "2025-11-01", resolvedOn: null }],
  vitals: [{ id: "v1", day: "2026-10-01", values: [{ loinc: "8867-4", name: "Heart rate", value: 72, unit: "/min" }] }],
  encounters: [{ id: "e1", day: "2026-10-01", label: "Established patient home visit", cptCodes: ["99349"] }],
  planned: [{ id: "e2", day: "2026-11-03", label: "Established patient home visit" }],
  goals: "Stay at home with family.",
  ...over,
});

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

const all = (root: Document | Element, tag: string) => [...root.getElementsByTagName(tag)];
const sectionOf = (doc: Document, loinc: string) =>
  all(doc, "section").find((s) => all(s, "code")[0]?.getAttribute("code") === loinc)!;
const templates = (root: Element | Document) => all(root, "templateId").map((t) => t.getAttribute("root"));

describe("the document", () => {
  const doc = parse(buildCcd(input()));

  it("declares itself a US Realm CCD in R2.1, for R1.1 receivers too", () => {
    const head = doc.documentElement;
    expect(head.tagName).toBe("ClinicalDocument");
    const own = [...head.children].filter((c) => c.tagName === "templateId");
    expect(own.map((t) => [t.getAttribute("root"), t.getAttribute("extension")])).toEqual([
      ["2.16.840.1.113883.10.20.22.1.1", "2015-08-01"],
      ["2.16.840.1.113883.10.20.22.1.1", null],
      ["2.16.840.1.113883.10.20.22.1.2", "2015-08-01"],
      ["2.16.840.1.113883.10.20.22.1.2", null],
    ]);
    expect([...head.children].find((c) => c.tagName === "code")?.getAttribute("code")).toBe("34133-9");
    expect([...head.children].find((c) => c.tagName === "realmCode")?.getAttribute("code")).toBe("US");
  });

  it("carries every section a CCD requires, in codes", () => {
    const codes = all(doc, "section").map((s) => all(s, "code")[0]?.getAttribute("code"));
    expect(codes).toEqual(expect.arrayContaining(["48765-2", "10160-0", "11450-4", "47519-4", "30954-2", "29762-2", "8716-3"]));
    expect(codes).toEqual(expect.arrayContaining(["46240-8", "18776-5", "61146-7"]));
  });

  it("gives the patient as a receiver matches them", () => {
    const p = all(doc, "patient")[0]!;
    expect(all(p, "given")[0]!.textContent).toBe("Ruth");
    expect(all(p, "family")[0]!.textContent).toBe("Testcase");
    expect(all(p, "birthTime")[0]!.getAttribute("value")).toBe("19410512");
    expect(all(p, "administrativeGenderCode")[0]!.getAttribute("code")).toBe("F");
    expect(all(doc, "telecom")[0]!.getAttribute("value")).toBe("tel:+16145550100");
  });

  it("is signed by a person and held by the practice, by NPI", () => {
    const author = all(doc, "author")[0]!;
    expect(all(author, "id")[0]!.getAttribute("extension")).toBe("1679576722");
    expect(all(author, "family")[0]!.textContent).toBe("Okafor");
    expect(all(all(doc, "custodian")[0]!, "name")[0]!.textContent).toBe("Test Palliative");
    expect(all(doc, "effectiveTime")[0]!.getAttribute("value")).toBe("20261031153000+0000");
  });
});

describe("USCDI demographics", () => {
  it("puts the first race in the field, and the others in the extension", () => {
    const xml = buildCcd(input());
    const doc = parse(xml);
    expect(all(doc, "raceCode")[0]!.getAttribute("code")).toBe("2106-3");
    expect(xml).toContain('<sdtc:raceCode code="2054-5"');
  });

  it("says declined differently from never asked", () => {
    const declined = parse(buildCcd(input({ patient: { ...input().patient, raceCodes: [DECLINED], ethnicity: DECLINED, language: DECLINED } })));
    expect(all(declined, "raceCode")[0]!.getAttribute("nullFlavor")).toBe("ASKU");
    expect(all(declined, "ethnicGroupCode")[0]!.getAttribute("nullFlavor")).toBe("ASKU");
    expect(all(declined, "languageCode").at(-1)!.getAttribute("nullFlavor")).toBe("ASKU");
    const unasked = parse(buildCcd(input({ patient: { ...input().patient, raceCodes: [], ethnicity: null, language: null } })));
    expect(all(unasked, "raceCode")[0]!.getAttribute("nullFlavor")).toBe("UNK");
    expect(all(unasked, "ethnicGroupCode")[0]!.getAttribute("nullFlavor")).toBe("UNK");
  });

  it("gives the preferred language by its tag", () => {
    const doc = parse(buildCcd(input()));
    const lang = all(doc, "languageCommunication")[0]!;
    expect(all(lang, "languageCode")[0]!.getAttribute("code")).toBe("es");
    expect(all(lang, "preferenceInd")[0]!.getAttribute("value")).toBe("true");
  });

  it("takes one or more races, or declined alone", () => {
    expect(RaceSchema.safeParse(["2106-3", "2054-5"]).success).toBe(true);
    expect(RaceSchema.safeParse([DECLINED]).success).toBe(true);
    expect(RaceSchema.safeParse([DECLINED, "2106-3"]).success).toBe(false);
    expect(RaceSchema.safeParse(["9999-9"]).success).toBe(false);
    expect(RaceSchema.safeParse(["2106-3", "2106-3"]).success).toBe(false);
  });

  it("reads back on the chart in words", () => {
    expect(raceText(["2106-3", "2054-5"])).toBe("White, Black or African American");
    expect(raceText([DECLINED])).toBe("Declined to answer");
    expect(raceText([])).toBeNull();
    expect(ethnicityText("2135-2")).toBe("Hispanic or Latino");
    expect(languageText("es")).toBe("Spanish");
    expect(languageText(null)).toBeNull();
  });
});

describe("allergies", () => {
  it("nests the substance in a concern, RxNorm-coded, with its reaction", () => {
    const s = sectionOf(parse(buildCcd(input())), "48765-2");
    expect(templates(s)).toEqual(expect.arrayContaining(["2.16.840.1.113883.10.20.22.4.30", "2.16.840.1.113883.10.20.22.4.7", "2.16.840.1.113883.10.20.22.4.9"]));
    const entity = all(s, "playingEntity")[0]!;
    expect(all(entity, "code")[0]!.getAttribute("code")).toBe("7980");
    expect(all(entity, "code")[0]!.getAttribute("codeSystem")).toBe("2.16.840.1.113883.6.88");
    expect(all(s, "value")[0]!.getAttribute("code")).toBe("416098002");
    expect(s.textContent).toContain("Hives");
  });

  it("keeps a substance with no code as its own words, never a guess", () => {
    const s = sectionOf(
      parse(buildCcd(input({ allergies: [{ id: "a2", substance: "Cat dander", kind: "environmental", reaction: null, severity: null, status: "active", rxnormCui: null, recordedOn: null }] }))),
      "48765-2",
    );
    const code = all(all(s, "playingEntity")[0]!, "code")[0]!;
    expect(code.getAttribute("nullFlavor")).toBe("OTH");
    expect(code.getAttribute("code")).toBeNull();
    expect(all(code, "originalText")[0]!.textContent).toBe("Cat dander");
  });

  it("says no known allergies as a negated assertion", () => {
    const s = sectionOf(parse(buildCcd(input({ allergies: [], noKnownAllergies: true }))), "48765-2");
    expect(all(s, "observation")[0]!.getAttribute("negationInd")).toBe("true");
    expect(all(all(s, "playingEntity")[0]!, "code")[0]!.getAttribute("nullFlavor")).toBe("NA");
  });

  it("CONTROL: says nothing is known when nothing was recorded, which is not no allergies", () => {
    const s = sectionOf(parse(buildCcd(input({ allergies: [], noKnownAllergies: false }))), "48765-2");
    expect(s.getAttribute("nullFlavor")).toBe("NI");
    expect(all(s, "observation")).toHaveLength(0);
  });

  // HL7's R2.1 rules (CONF:1198-10085): a completed concern has a high.
  it("ends an inactive allergy's concern, unknown when the chart has no day for it", () => {
    const s = sectionOf(
      parse(buildCcd(input({ allergies: [{ ...input().allergies[0]!, status: "inactive" }] }))),
      "48765-2",
    );
    const concern = all(s, "act")[0]!;
    expect(all(concern, "statusCode")[0]!.getAttribute("code")).toBe("completed");
    const time = [...concern.children].find((c) => c.tagName === "effectiveTime")!;
    expect(all(time, "high")[0]!.getAttribute("nullFlavor")).toBe("UNK");
  });

  it("CONTROL: an active allergy's concern has no end", () => {
    const concern = all(sectionOf(parse(buildCcd(input())), "48765-2"), "act")[0]!;
    const time = [...concern.children].find((c) => c.tagName === "effectiveTime")!;
    expect(all(time, "high")).toHaveLength(0);
  });
});

describe("the clinical sections", () => {
  const doc = parse(buildCcd(input()));

  it("codes a medication in RxNorm where one was chosen, and keeps free text as it is", () => {
    const s = sectionOf(doc, "10160-0");
    const [a, b] = all(s, "manufacturedMaterial").map((m) => all(m, "code")[0]!);
    expect(a!.getAttribute("code")).toBe("314076");
    expect(b!.getAttribute("nullFlavor")).toBe("OTH");
    expect(all(b!, "originalText")[0]!.textContent).toBe("Grandma's tea");
    expect(all(s, "statusCode").map((x) => x.getAttribute("code"))).toEqual(["active", "completed"]);
    expect(s.textContent).toContain("10 mg");
  });

  // R2.1 requires a doseQuantity (CONF:1098-7516); the chart's dose is free text.
  it("gives every medication its dose as unknown, and the typed dose in the table", () => {
    const s = sectionOf(doc, "10160-0");
    const doses = all(s, "substanceAdministration").map((m) => [...m.children].filter((c) => c.tagName === "doseQuantity"));
    expect(doses.map((d) => d.length)).toEqual([1, 1]);
    expect(doses.map((d) => d[0]!.getAttribute("nullFlavor"))).toEqual(["UNK", "UNK"]);
    expect(all(s, "td").map((td) => td.textContent)).toContain("10 mg");
  });

  it("codes a problem in ICD-10-CM inside its concern", () => {
    const s = sectionOf(doc, "11450-4");
    const v = all(s, "value")[0]!;
    expect(v.getAttribute("code")).toBe("C34.90");
    expect(v.getAttribute("codeSystem")).toBe("2.16.840.1.113883.6.90");
    expect(all(s, "act")[0]!.getAttribute("classCode")).toBe("ACT");
  });

  it("marks a resolved problem as over, on its day or unknown, and an active one as not", () => {
    const ends = (p: Partial<CcdInput["problems"][number]>) => {
      const s = sectionOf(parse(buildCcd(input({ problems: [{ ...input().problems[0]!, ...p }] }))), "11450-4");
      // The concern's time, then the observation's.
      return all(s, "effectiveTime").map((t) => {
        const high = all(t, "high")[0];
        return high ? (high.getAttribute("value") ?? high.getAttribute("nullFlavor")) : null;
      });
    };
    expect(ends({ status: "resolved", resolvedOn: "2026-03-01" })).toEqual(["20260301", "20260301"]);
    expect(ends({ status: "resolved", resolvedOn: null })).toEqual(["UNK", "UNK"]);
    expect(ends({ status: "active", resolvedOn: null })).toEqual([null, null]);
  });

  it("gives vitals in LOINC and UCUM", () => {
    const s = sectionOf(doc, "8716-3");
    expect(all(s, "organizer")).toHaveLength(1);
    const v = all(s, "value")[0]!;
    expect([v.getAttribute("value"), v.getAttribute("unit")]).toEqual(["72", "/min"]);
    expect(all(s, "code").some((c) => c.getAttribute("code") === "8867-4")).toBe(true);
  });

  it("gives visits made, and visits planned as intended", () => {
    expect(all(sectionOf(doc, "46240-8"), "encounter")[0]!.getAttribute("moodCode")).toBe("EVN");
    expect(all(sectionOf(doc, "18776-5"), "encounter")[0]!.getAttribute("moodCode")).toBe("INT");
  });

  it("leaves out the goals section with no goals, and fills required ones with no information", () => {
    const none = parse(buildCcd(input({ goals: null, medications: [], problems: [], vitals: [], encounters: [], planned: [] })));
    expect(sectionOf(none, "61146-7")).toBeUndefined();
    for (const code of ["10160-0", "11450-4", "8716-3", "47519-4", "30954-2"]) {
      expect(sectionOf(none, code).getAttribute("nullFlavor")).toBe("NI");
    }
  });

  it("gives every entry an id, and the sex assigned at birth in the social history", () => {
    const s = sectionOf(doc, "29762-2");
    expect(all(s, "value")[0]!.getAttribute("code")).toBe("F");
    expect(templates(s)).toContain("2.16.840.1.113883.10.20.22.4.200");
    for (const tag of ["act", "substanceAdministration", "organizer", "encounter"]) {
      for (const el of all(doc, tag)) expect(all(el, "id").length).toBeGreaterThan(0);
    }
  });
});

describe("what is typed on a chart", () => {
  it("cannot change the document", () => {
    const hostile = `</text></section><script>x</script> & "quotes" <b>`;
    const doc = parse(
      buildCcd(input({
        goals: hostile,
        patient: { ...input().patient, firstName: hostile },
        medications: [{ id: "m1", name: hostile, dose: hostile, route: null, frequency: null, status: "active", startedOn: null, stoppedOn: null, rxnormCui: null }],
      })),
    );
    expect(all(doc, "script")).toHaveLength(0);
    expect(all(doc, "given")[0]!.textContent).toBe(hostile);
  });

  it("drops a control character XML cannot hold", () => {
    parse(buildCcd(input({ goals: "Stay home\u0007" })));
  });
});

describe("the chart's vitals", () => {
  it("names those taken, in LOINC and UCUM, and leaves out the rest", () => {
    expect(ccdVitals({ heart_rate: 72, temperature_c: "37.2", weight_kg: null, spo2_percent: undefined, pain_score: 4 })).toEqual([
      { loinc: "8867-4", name: "Heart rate", value: 72, unit: "/min" },
      { loinc: "8310-5", name: "Body temperature", value: 37.2, unit: "Cel" },
    ]);
  });
});
