/**
 * A patient's record as a C-CDA R2.1 Continuity of Care Document, the file ONC's
 * certification (b)(1) and (e)(1) exchange and that another EHR can import.
 *
 * Pure: the service reads the chart, this writes the XML. Every section has its
 * human-readable table and its coded entries. A section the CCD requires and the
 * chart has nothing for says so with nullFlavor="NI", as the guide allows.
 *
 * What is coded is what the chart holds in codes: RxNorm for medications and
 * drug allergies where a clinician chose one, ICD-10-CM for problems, CPT for
 * encounters, LOINC and UCUM for vitals, and the CDC set for race and ethnicity.
 * A medication typed as free text keeps its words in originalText rather than a
 * guessed code. Dose, route and frequency are free text on the chart, so they go
 * in the table, not in coded fields they would not fit.
 *
 * Text goes through xmlText, so nothing typed on a chart can change the document.
 */
import { xmlText } from "@/lib/features/reports/xlsx-writer";

import { DECLINED, ETHNICITY_OPTIONS, LANGUAGE_OPTIONS, RACE_OPTIONS } from "./uscdi";

const CS = {
  loinc: "2.16.840.1.113883.6.1",
  snomed: "2.16.840.1.113883.6.96",
  rxnorm: "2.16.840.1.113883.6.88",
  icd10: "2.16.840.1.113883.6.90",
  cpt: "2.16.840.1.113883.6.12",
  race: "2.16.840.1.113883.6.238",
  gender: "2.16.840.1.113883.5.1",
  actCode: "2.16.840.1.113883.5.4",
  actClass: "2.16.840.1.113883.5.6",
  npi: "2.16.840.1.113883.4.6",
  nullFlavor: "2.16.840.1.113883.5.1008",
};

export interface CcdPatient {
  id: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** F, M or U */
  sex: "F" | "M" | "U";
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  raceCodes: string[];
  ethnicity: string | null;
  language: string | null;
}

export interface CcdInput {
  /** A UUID: this document's own id. */
  documentId: string;
  now: Date;
  org: { id: string; name: string; phone: string | null; line1: string | null; city: string | null; state: string | null; zip: string | null; npi: string | null };
  author: { name: string; npi: string | null };
  patient: CcdPatient;
  allergies: { id: string; substance: string; kind: string; reaction: string | null; severity: string | null; status: string; rxnormCui: string | null; recordedOn: string | null }[];
  noKnownAllergies: boolean;
  medications: { id: string; name: string; dose: string | null; route: string | null; frequency: string | null; status: string; startedOn: string | null; stoppedOn: string | null; rxnormCui: string | null }[];
  problems: { id: string; icd10: string; description: string; status: string; onsetOn: string | null; resolvedOn: string | null }[];
  vitals: { id: string; day: string; values: { loinc: string; name: string; value: number; unit: string }[] }[];
  encounters: { id: string; day: string; label: string; cptCodes: string[] }[];
  planned: { id: string; day: string; label: string }[];
  goals: string | null;
}

const esc = xmlText;

/** YYYYMMDD from YYYY-MM-DD. */
const hl7Day = (day: string) => day.replace(/-/g, "");

/** An instant as HL7 writes one, in UTC. */
function hl7Instant(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace(/[-:T]/g, "")}+0000`;
}

/** The R2.1 template, and the plain one for receivers still on R1.1. */
const tmpl = (root: string, ext?: string) => (ext ? `<templateId root="${root}" extension="${ext}"/><templateId root="${root}"/>` : `<templateId root="${root}"/>`);

/** An id for an entry: the row's own UUID, and which part of the row when it makes two entries. */
const id = (uuid: string, part?: string) => `<id root="${esc(uuid)}"${part ? ` extension="${part}"` : ""}/>`;

/**
 * When it held. Something over has a high: its day, or UNK when the chart never
 * recorded one. R2.1 requires it on a completed concern (CONF:1198-10085), and a
 * problem's high is what says it is resolved.
 */
const effective = (low: string | null, high?: string | null, over = false) =>
  `<effectiveTime>${low ? `<low value="${hl7Day(low)}"/>` : '<low nullFlavor="UNK"/>'}${high ? `<high value="${hl7Day(high)}"/>` : over ? '<high nullFlavor="UNK"/>' : ""}</effectiveTime>`;

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function section(a: { root: string; ext?: string; code: string; codeName: string; title: string; text: string; entries?: string[]; noInformation?: boolean }): string {
  const entries = (a.entries ?? []).map((e) => `<entry>${e}</entry>`).join("");
  return (
    `<component><section${a.noInformation ? ' nullFlavor="NI"' : ""}>${tmpl(a.root, a.ext)}` +
    `<code code="${a.code}" codeSystem="${CS.loinc}" codeSystemName="LOINC" displayName="${esc(a.codeName)}"/>` +
    `<title>${esc(a.title)}</title><text>${a.text}</text>${entries}</section></component>`
  );
}

const noInformation = (a: { root: string; ext?: string; code: string; codeName: string; title: string }) => section({ ...a, text: "No information.", noInformation: true });

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

function addrXml(a: { line1: string | null; city: string | null; state: string | null; zip: string | null }): string {
  if (!a.line1 && !a.city && !a.state && !a.zip) return '<addr nullFlavor="UNK"/>';
  const part = (tag: string, v: string | null) => (v ? `<${tag}>${esc(v)}</${tag}>` : `<${tag} nullFlavor="UNK"/>`);
  return `<addr use="HP">${part("streetAddressLine", a.line1)}${part("city", a.city)}${part("state", a.state)}${part("postalCode", a.zip)}<country>US</country></addr>`;
}

function telecom(phone: string | null, use: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits ? `<telecom use="${use}" value="tel:+1${digits.slice(-10)}"/>` : '<telecom nullFlavor="UNK"/>';
}

function raceXml(codes: string[]): string {
  if (codes.length === 0) return '<raceCode nullFlavor="UNK"/>';
  if (codes.includes(DECLINED)) return '<raceCode nullFlavor="ASKU"/>';
  const one = (tag: string, code: string) => {
    const name = RACE_OPTIONS.find((r) => r.code === code)?.label ?? code;
    return `<${tag} code="${code}" codeSystem="${CS.race}" codeSystemName="Race &amp; Ethnicity - CDC" displayName="${esc(name)}"/>`;
  };
  // The first goes in the CDA field; any more go in the extension for them.
  return one("raceCode", codes[0]!) + codes.slice(1).map((c) => one("sdtc:raceCode", c)).join("");
}

function ethnicityXml(code: string | null): string {
  if (!code) return '<ethnicGroupCode nullFlavor="UNK"/>';
  if (code === DECLINED) return '<ethnicGroupCode nullFlavor="ASKU"/>';
  const name = ETHNICITY_OPTIONS.find((e) => e.code === code)?.label ?? code;
  return `<ethnicGroupCode code="${code}" codeSystem="${CS.race}" codeSystemName="Race &amp; Ethnicity - CDC" displayName="${esc(name)}"/>`;
}

function languageXml(code: string | null): string {
  if (!code || code === DECLINED) return `<languageCommunication><languageCode nullFlavor="${code === DECLINED ? "ASKU" : "UNK"}"/></languageCommunication>`;
  const known = LANGUAGE_OPTIONS.some((l) => l.code === code);
  return `<languageCommunication><languageCode code="${esc(known ? code : "und")}"/><preferenceInd value="true"/></languageCommunication>`;
}

function headerXml(i: CcdInput): string {
  const p = i.patient;
  const orgId = i.org.npi ? `<id root="${CS.npi}" extension="${esc(i.org.npi)}"/>` : id(i.org.id);
  const authorId = i.author.npi ? `<id root="${CS.npi}" extension="${esc(i.author.npi)}"/>` : '<id nullFlavor="UNK"/>';
  const genderName = { F: "Female", M: "Male", U: "Unknown" }[p.sex];
  const gender = p.sex === "U" ? '<administrativeGenderCode nullFlavor="UNK"/>' : `<administrativeGenderCode code="${p.sex}" codeSystem="${CS.gender}" displayName="${genderName}"/>`;
  const [family, ...rest] = i.author.name.trim().split(/\s+/).reverse();
  const given = rest.reverse().join(" ");
  const orgAddr = addrXml(i.org).replace(' use="HP"', ' use="WP"');
  return (
    '<realmCode code="US"/><typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>' +
    tmpl("2.16.840.1.113883.10.20.22.1.1", "2015-08-01") +
    tmpl("2.16.840.1.113883.10.20.22.1.2", "2015-08-01") +
    `<id root="${esc(i.documentId)}"/>` +
    `<code code="34133-9" codeSystem="${CS.loinc}" codeSystemName="LOINC" displayName="Summarization of Episode Note"/>` +
    `<title>Continuity of Care Document</title><effectiveTime value="${hl7Instant(i.now)}"/>` +
    `<confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25" displayName="Normal"/><languageCode code="en-US"/>` +
    `<recordTarget><patientRole><id root="${esc(i.org.id)}" extension="${esc(p.id)}"/>${addrXml({ line1: p.addressLine1, city: p.city, state: p.state, zip: p.zip })}${telecom(p.phone, "HP")}` +
    `<patient><name use="L"><given>${esc(p.firstName)}</given><family>${esc(p.lastName)}</family></name>${gender}<birthTime value="${hl7Day(p.dateOfBirth)}"/>` +
    `${raceXml(p.raceCodes)}${ethnicityXml(p.ethnicity)}${languageXml(p.language)}</patient></patientRole></recordTarget>` +
    `<author><time value="${hl7Instant(i.now)}"/><assignedAuthor>${authorId}${orgAddr}${telecom(i.org.phone, "WP")}` +
    `<assignedPerson><name><given>${esc(given || family || "Unknown")}</given><family>${esc(family || "Unknown")}</family></name></assignedPerson></assignedAuthor></author>` +
    `<custodian><assignedCustodian><representedCustodianOrganization>${orgId}<name>${esc(i.org.name)}</name>${telecom(i.org.phone, "WP")}${orgAddr}</representedCustodianOrganization></assignedCustodian></custodian>` +
    `<documentationOf><serviceEvent classCode="PCPR"><effectiveTime><low value="${hl7Day(i.patient.dateOfBirth)}"/><high value="${hl7Instant(i.now)}"/></effectiveTime></serviceEvent></documentationOf>`
  );
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

/** What the allergy's type says in SNOMED. */
const ALLERGY_TYPE: Record<string, { code: string; name: string }> = {
  drug: { code: "416098002", name: "Allergy to drug" },
  food: { code: "414285001", name: "Allergy to food" },
  environmental: { code: "419199007", name: "Allergy to substance" },
  other: { code: "419199007", name: "Allergy to substance" },
};

const CONCERN = `<code code="CONC" codeSystem="${CS.actClass}" displayName="Concern"/>`;

function allergiesSection(i: CcdInput): string {
  const base = { root: "2.16.840.1.113883.10.20.22.2.6.1", ext: "2015-08-01", code: "48765-2", codeName: "Allergies and adverse reactions", title: "Allergies and Intolerances" };
  if (i.allergies.length === 0 && !i.noKnownAllergies) return noInformation(base);
  if (i.allergies.length === 0) {
    const entry =
      `<act classCode="ACT" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.30", "2015-08-01")}${id(i.documentId, "allergies")}${CONCERN}<statusCode code="active"/>${effective(null)}` +
      `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN" negationInd="true">${tmpl("2.16.840.1.113883.10.20.22.4.7", "2014-06-09")}${id(i.documentId, "no-known-allergies")}` +
      `<code code="ASSERTION" codeSystem="${CS.actCode}"/><statusCode code="completed"/>${effective(null)}` +
      `<value xsi:type="CD" code="419199007" codeSystem="${CS.snomed}" displayName="Allergy to substance"/>` +
      `<participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT"><code nullFlavor="NA"/></playingEntity></participantRole></participant></observation></entryRelationship></act>`;
    return section({ ...base, text: "No known allergies.", entries: [entry] });
  }
  const entries = i.allergies.map((a) => {
    const type = ALLERGY_TYPE[a.kind] ?? ALLERGY_TYPE.other!;
    const substance = a.rxnormCui
      ? `<code code="${esc(a.rxnormCui)}" codeSystem="${CS.rxnorm}" codeSystemName="RxNorm" displayName="${esc(a.substance)}"/>`
      : `<code nullFlavor="OTH"><originalText>${esc(a.substance)}</originalText></code>`;
    const reaction = a.reaction
      ? `<entryRelationship typeCode="MFST" inversionInd="true"><observation classCode="OBS" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.9", "2014-06-09")}${id(a.id, "reaction")}` +
        `<code code="ASSERTION" codeSystem="${CS.actCode}"/><statusCode code="completed"/>${effective(a.recordedOn)}<value xsi:type="CD" nullFlavor="OTH"><originalText>${esc(a.reaction)}</originalText></value></observation></entryRelationship>`
      : "";
    return (
      `<act classCode="ACT" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.30", "2015-08-01")}${id(a.id)}${CONCERN}<statusCode code="${a.status === "active" ? "active" : "completed"}"/>${effective(a.recordedOn, null, a.status !== "active")}` +
      `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.7", "2014-06-09")}${id(a.id, "allergy")}` +
      `<code code="ASSERTION" codeSystem="${CS.actCode}"/><statusCode code="completed"/>${effective(a.recordedOn)}` +
      `<value xsi:type="CD" code="${type.code}" codeSystem="${CS.snomed}" displayName="${type.name}"/>` +
      `<participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">${substance}</playingEntity></participantRole></participant>${reaction}</observation></entryRelationship></act>`
    );
  });
  const rows = i.allergies.map((a) => [a.substance, a.reaction ?? "", a.severity ?? "", a.status]);
  return section({ ...base, text: table(["Substance", "Reaction", "Severity", "Status"], rows), entries });
}

function medicationsSection(i: CcdInput): string {
  const base = { root: "2.16.840.1.113883.10.20.22.2.1.1", ext: "2014-06-09", code: "10160-0", codeName: "History of medication use", title: "Medications" };
  if (i.medications.length === 0) return noInformation(base);
  const entries = i.medications.map((m) => {
    const code = m.rxnormCui
      ? `<code code="${esc(m.rxnormCui)}" codeSystem="${CS.rxnorm}" codeSystemName="RxNorm" displayName="${esc(m.name)}"/>`
      : `<code nullFlavor="OTH"><originalText>${esc(m.name)}</originalText></code>`;
    return (
      `<substanceAdministration classCode="SBADM" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.16", "2014-06-09")}${id(m.id)}` +
      `<statusCode code="${m.status === "active" ? "active" : "completed"}"/>` +
      `<effectiveTime xsi:type="IVL_TS">${m.startedOn ? `<low value="${hl7Day(m.startedOn)}"/>` : '<low nullFlavor="UNK"/>'}${m.stoppedOn ? `<high value="${hl7Day(m.stoppedOn)}"/>` : ""}</effectiveTime>` +
      // R2.1 requires one (CONF:1098-7516). The dose is free text on the chart,
      // so it is in the table as typed, and here it is unknown.
      '<doseQuantity nullFlavor="UNK"/>' +
      `<consumable><manufacturedProduct classCode="MANU">${tmpl("2.16.840.1.113883.10.20.22.4.23", "2014-06-09")}<manufacturedMaterial>${code}</manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration>`
    );
  });
  const rows = i.medications.map((m) => [m.name, m.dose ?? "", m.route ?? "", m.frequency ?? "", m.status, m.startedOn ?? "", m.stoppedOn ?? ""]);
  return section({ ...base, text: table(["Medication", "Dose", "Route", "How often", "Status", "Started", "Stopped"], rows), entries });
}

function problemsSection(i: CcdInput): string {
  const base = { root: "2.16.840.1.113883.10.20.22.2.5.1", ext: "2015-08-01", code: "11450-4", codeName: "Problem list", title: "Problems" };
  if (i.problems.length === 0) return noInformation(base);
  const entries = i.problems.map((p) => {
    const active = p.status === "active";
    return (
      `<act classCode="ACT" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.3", "2015-08-01")}${id(p.id)}${CONCERN}<statusCode code="${active ? "active" : "completed"}"/>${effective(p.onsetOn, p.resolvedOn, !active)}` +
      `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.4", "2015-08-01")}${id(p.id, "problem")}` +
      `<code code="55607006" codeSystem="${CS.snomed}" displayName="Problem"><translation code="75326-9" codeSystem="${CS.loinc}" displayName="Problem"/></code><statusCode code="completed"/>${effective(p.onsetOn, p.resolvedOn, !active)}` +
      `<value xsi:type="CD" code="${esc(p.icd10)}" codeSystem="${CS.icd10}" codeSystemName="ICD-10-CM" displayName="${esc(p.description)}"/></observation></entryRelationship></act>`
    );
  });
  const rows = i.problems.map((p) => [p.icd10, p.description, p.status, p.onsetOn ?? "", p.resolvedOn ?? ""]);
  return section({ ...base, text: table(["Code", "Problem", "Status", "Onset", "Resolved"], rows), entries });
}

function vitalsSection(i: CcdInput): string {
  const base = { root: "2.16.840.1.113883.10.20.22.2.4.1", ext: "2015-08-01", code: "8716-3", codeName: "Vital signs", title: "Vital Signs" };
  const taken = i.vitals.filter((v) => v.values.length > 0);
  if (taken.length === 0) return noInformation(base);
  const entries = taken.map((v) => {
    const parts = v.values.map(
      (x, k) =>
        `<component><observation classCode="OBS" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.27", "2014-06-09")}<id root="${esc(v.id)}" extension="${k}"/>` +
        `<code code="${x.loinc}" codeSystem="${CS.loinc}" codeSystemName="LOINC" displayName="${esc(x.name)}"/><statusCode code="completed"/><effectiveTime value="${hl7Day(v.day)}"/>` +
        `<value xsi:type="PQ" value="${x.value}" unit="${esc(x.unit)}"/></observation></component>`,
    );
    return (
      `<organizer classCode="CLUSTER" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.26", "2015-08-01")}${id(v.id)}` +
      `<code code="46680005" codeSystem="${CS.snomed}" displayName="Vital signs"><translation code="74728-7" codeSystem="${CS.loinc}" displayName="Vital signs"/></code>` +
      `<statusCode code="completed"/><effectiveTime value="${hl7Day(v.day)}"/>${parts.join("")}</organizer>`
    );
  });
  const rows = taken.flatMap((v) => v.values.map((x) => [v.day, x.name, `${x.value} ${x.unit}`]));
  return section({ ...base, text: table(["Date", "Measure", "Value"], rows), entries });
}

function encountersSection(i: CcdInput): string {
  const base = { root: "2.16.840.1.113883.10.20.22.2.22.1", ext: "2015-08-01", code: "46240-8", codeName: "History of hospitalizations+Outpatient visits", title: "Encounters" };
  if (i.encounters.length === 0) return noInformation(base);
  const entries = i.encounters.map((e) => {
    const code = e.cptCodes[0]
      ? `<code code="${esc(e.cptCodes[0])}" codeSystem="${CS.cpt}" codeSystemName="CPT" displayName="${esc(e.label)}"/>`
      : `<code nullFlavor="OTH"><originalText>${esc(e.label)}</originalText></code>`;
    return `<encounter classCode="ENC" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.49", "2015-08-01")}${id(e.id)}${code}<effectiveTime value="${hl7Day(e.day)}"/></encounter>`;
  });
  return section({ ...base, text: table(["Date", "Visit", "Codes"], i.encounters.map((e) => [e.day, e.label, e.cptCodes.join(", ")])), entries });
}

function planSection(i: CcdInput): string {
  const base = { root: "2.16.840.1.113883.10.20.22.2.10", ext: "2014-06-09", code: "18776-5", codeName: "Plan of care note", title: "Plan of Treatment" };
  if (i.planned.length === 0) return noInformation(base);
  const entries = i.planned.map(
    (p) =>
      `<encounter classCode="ENC" moodCode="INT">${tmpl("2.16.840.1.113883.10.20.22.4.40", "2014-06-09")}${id(p.id)}<code nullFlavor="OTH"><originalText>${esc(p.label)}</originalText></code><statusCode code="active"/><effectiveTime value="${hl7Day(p.day)}"/></encounter>`,
  );
  return section({ ...base, text: table(["Date", "Planned visit"], i.planned.map((p) => [p.day, p.label])), entries });
}

function goalsSection(i: CcdInput): string {
  if (!i.goals?.trim()) return "";
  const entry =
    `<observation classCode="OBS" moodCode="GOL">${tmpl("2.16.840.1.113883.10.20.22.4.121")}${id(i.documentId, "goals")}<code nullFlavor="OTH"><originalText>${esc(i.goals)}</originalText></code><statusCode code="active"/></observation>`;
  return section({ root: "2.16.840.1.113883.10.20.22.2.60", code: "61146-7", codeName: "Goals", title: "Goals of Care", text: `<paragraph>${esc(i.goals)}</paragraph>`, entries: [entry] });
}

function socialSection(i: CcdInput): string {
  const base = { root: "2.16.840.1.113883.10.20.22.2.17", ext: "2015-08-01", code: "29762-2", codeName: "Social history", title: "Social History" };
  if (i.patient.sex === "U") return noInformation(base);
  const name = i.patient.sex === "F" ? "Female" : "Male";
  const entry =
    `<observation classCode="OBS" moodCode="EVN">${tmpl("2.16.840.1.113883.10.20.22.4.200", "2016-06-01")}<code code="76689-9" codeSystem="${CS.loinc}" displayName="Sex assigned at birth"/><statusCode code="completed"/>` +
    `<effectiveTime value="${hl7Day(i.patient.dateOfBirth)}"/><value xsi:type="CD" code="${i.patient.sex}" codeSystem="${CS.gender}" displayName="${name}"/></observation>`;
  return section({ ...base, text: `<paragraph>Sex assigned at birth: ${name}</paragraph>`, entries: [entry] });
}

/** The CCD, as a complete XML document. */
export function buildCcd(i: CcdInput): string {
  const sections = [
    allergiesSection(i),
    medicationsSection(i),
    problemsSection(i),
    noInformation({ root: "2.16.840.1.113883.10.20.22.2.7.1", ext: "2014-06-09", code: "47519-4", codeName: "History of procedures", title: "Procedures" }),
    noInformation({ root: "2.16.840.1.113883.10.20.22.2.3.1", ext: "2015-08-01", code: "30954-2", codeName: "Relevant diagnostic tests and/or laboratory data", title: "Results" }),
    socialSection(i),
    vitalsSection(i),
    encountersSection(i),
    planSection(i),
    goalsSection(i),
  ];
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:sdtc="urn:hl7-org:sdtc" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `${headerXml(i)}<component><structuredBody>${sections.join("")}</structuredBody></component></ClinicalDocument>`
  );
}

/** The chart's vitals in LOINC and UCUM, those that were taken. */
export function ccdVitals(v: Record<string, unknown>): { loinc: string; name: string; value: number; unit: string }[] {
  const out: { loinc: string; name: string; value: number; unit: string }[] = [];
  const add = (key: string, loinc: string, name: string, unit: string) => {
    const x = v[key];
    if (x !== null && x !== undefined && Number.isFinite(Number(x))) out.push({ loinc, name, value: Number(x), unit });
  };
  add("bp_systolic", "8480-6", "Systolic blood pressure", "mm[Hg]");
  add("bp_diastolic", "8462-4", "Diastolic blood pressure", "mm[Hg]");
  add("heart_rate", "8867-4", "Heart rate", "/min");
  add("resp_rate", "9279-1", "Respiratory rate", "/min");
  add("temperature_c", "8310-5", "Body temperature", "Cel");
  add("spo2_percent", "59408-5", "Oxygen saturation by pulse oximetry", "%");
  add("weight_kg", "29463-7", "Body weight", "kg");
  add("height_cm", "8302-2", "Body height", "cm");
  return out;
}
