/**
 * What the codes in a response mean, in a sentence a biller can act on
 * (0120). Pure and client-safe: the queue, the bill page and the files page
 * all print them.
 *
 * Written in our own words and kept to the codes a palliative practice meets;
 * an unlisted code prints as itself, and the payer's own message (STC12, MSG)
 * is shown beside it, which is usually the clearest explanation of all.
 */

/** 277/277CA STC01-1: the status category. */
export const STATUS_CATEGORIES: Record<string, string> = {
  A0: "Forwarded to another entity",
  A1: "Received",
  A2: "Accepted for processing",
  A3: "Returned as unprocessable",
  A4: "Not found",
  A5: "Split into more than one claim",
  A6: "Rejected for missing information",
  A7: "Rejected for invalid information",
  A8: "Rejected: fields that must agree do not",
  D0: "The payer could not find it",
  E0: "The question could not be answered: its data was in error",
  E1: "The question could not be answered right now",
  E2: "The payer is not responding",
  E3: "The question needs a correction",
  E4: "A trading partner requirement was not met",
  F0: "Finalized",
  F1: "Finalized: paid",
  F2: "Finalized: denied",
  F3: "Finalized: revised",
  F3F: "Finalized: forwarded",
  F3N: "Finalized: not forwarded",
  F4: "Finalized: no payment will be issued",
  P0: "Pending: adjudication",
  P1: "Pending: in process",
  P2: "Pending: payer review",
  P3: "Pending: provider requested information",
  P4: "Pending: patient requested information",
  P5: "Pending: payer administrative or system hold",
  R0: "More information requested: general",
  R1: "More information requested: entity",
  R3: "More information requested: claim or line",
  R4: "More information requested: documentation",
  R5: "More information requested: more specific detail",
  R6: "More information requested: regulatory",
  R7: "More information requested: confirmation of a patient condition",
  R8: "More information requested: verification of a patient condition",
  R9: "More information requested: disability",
  R10: "More information requested: service",
  R11: "More information requested: patient history",
  R12: "More information requested: payer administrative",
  R13: "More information requested: procedure",
  R14: "More information requested: dental",
  R15: "More information requested: drug",
  R16: "More information requested: other insurance",
};

/**
 * 277 STC01-2: the claim status codes seen most on professional claims.
 * The full list is long and maintained by X12; an unlisted code shows as its
 * number with the payer's message.
 */
export const STATUS_CODES: Record<string, string> = {
  "0": "Cannot provide further status electronically",
  "1": "For more detailed information, see the remittance advice",
  "2": "More detailed information in letter",
  "3": "Claim has been adjudicated and is awaiting payment cycle",
  "6": "Balance due from the subscriber",
  "12": "One or more originally submitted procedure codes have been combined",
  "15": "One or more originally submitted procedure codes have been modified",
  "16": "Claim or encounter has been forwarded to the entity",
  "17": "Claim or encounter has been forwarded by a third-party entity to the entity",
  "18": "Entity received the claim but returned it as invalid",
  "19": "Entity acknowledges receipt of the claim",
  "20": "Accepted for processing",
  "21": "Missing or invalid information",
  "23": "Returned to the entity",
  "24": "Entity not approved as an electronic submitter",
  "25": "Entity not approved",
  "26": "Entity not found",
  "27": "Policy cancelled",
  "29": "Subscriber and policy number or contract number mismatched",
  "30": "Subscriber and subscriber ID mismatched",
  "31": "Subscriber and policyholder name mismatched",
  "32": "Subscriber and policy number or contract number not found",
  "33": "Subscriber and subscriber ID not found",
  "35": "Procedure or revenue code not valid for the date of service",
  "38": "Diagnosis code(s) missing or invalid",
  "40": "Waiting for information from another entity",
  "41": "Further information requested from the entity",
  "44": "Charges are not valid",
  "45": "Charges or total charges are not valid",
  "48": "Procedure code invalid",
  "52": "Procedure code invalid for the patient's age",
  "53": "Procedure code invalid for the patient's gender",
  "54": "Invalid diagnosis code for the patient's age",
  "57": "Date(s) of service",
  "60": "Date of service must be on or after the date of birth",
  "62": "Total charge amount",
  "65": "Claim/line has been paid",
  "85": "Billing provider name or ID missing or invalid",
  "86": "Billing provider identifier",
  "88": "Entity's National Provider Identifier (NPI)",
  "89": "Entity's taxonomy",
  "92": "Pay-to provider address",
  "97": "Patient eligibility not found with the entity",
  "107": "Processed according to contract provisions",
  "116": "Claim submitted to the incorrect payer",
  "122": "Missing or invalid data prevents payer from processing the claim",
  "123": "Additional information requested from the entity",
  "128": "Entity's tax ID",
  "145": "Entity's specialty or taxonomy code",
  "153": "Entity's ID number",
  "187": "Date(s) of service",
  "189": "Facility type code",
  "202": "Claim filing indicator",
  "210": "Place of service",
  "247": "Line information",
  "249": "Place of service code",
  "255": "Diagnosis code",
  "286": "Other payer's explanation of benefits or payment information",
  "306": "Detailed and itemized description of service",
  "354": "Information not provided or not received from the entity",
  "400": "Claim is out of balance",
  "403": "Revenue code for services rendered",
  "448": "Transaction set header invalid",
  "454": "Procedure code for services rendered",
  "455": "Revenue code and procedure code mismatch",
  "460": "Rendering provider NPI",
  "479": "Other payer's claim filing indicator code",
  "484": "Business application currently not available",
  "496": "Submitter not approved for electronic claim submissions on behalf of this entity",
  "509": "Missing patient date of birth",
  "512": "Length of time between the services",
  "516": "Diagnosis code pointer is missing or invalid",
  "545": "Diagnosis code is missing, invalid or does not support the procedure",
  "562": "Entity's National Provider Identifier (NPI) not on file",
  "673": "Patient Medicare number",
  "674": "Patient Medicaid number",
  "685": "Claim could not complete adjudication in real time",
  "686": "Duplicate of a previously processed claim or line",
  "687": "Claim estimation can not be completed in real time",
  "688": "Duplicate of a claim/line already in process",
  "709": "Entity's tax ID or EIN",
  "718": "Claim did not include the patient's medical record for the service",
};

/** STC01-3: whom a status is about. */
export const STATUS_ENTITIES: Record<string, string> = {
  "03": "the dependent",
  "1P": "the provider",
  "40": "the receiver",
  "41": "the submitter",
  "77": "the service location",
  "82": "the rendering provider",
  "85": "the billing provider",
  "87": "the pay-to provider",
  IL: "the subscriber",
  PR: "the payer",
  QC: "the patient",
};

/** 999 IK304: what was wrong with a segment. */
export const SEGMENT_ERRORS: Record<string, string> = {
  "1": "an unrecognised segment",
  "2": "an unexpected segment",
  "3": "a required segment missing",
  "4": "a loop repeated too many times",
  "5": "a segment repeated too many times",
  "6": "a segment not in the defined transaction set",
  "7": "a segment out of order",
  "8": "a segment with data element errors",
  I4: "a segment not used in this implementation",
  I6: "an implementation dependent segment missing",
  I7: "an implementation loop repeated too many times",
  I8: "an implementation segment below minimum use",
  I9: "an implementation dependent 'not used' segment present",
};

/** 999 IK403: what was wrong with an element. */
export const ELEMENT_ERRORS: Record<string, string> = {
  "1": "a required element missing",
  "2": "a conditional required element missing",
  "3": "too many elements",
  "4": "the element is too short",
  "5": "the element is too long",
  "6": "invalid characters",
  "7": "an invalid code value",
  "8": "an invalid date",
  "9": "an invalid time",
  "10": "an element excluded by the standard is present",
  "12": "too many repetitions",
  "13": "too many components",
  I6: "a code value not used in this implementation",
  I9: "an implementation dependent element missing",
  I10: "an implementation 'not used' element present",
  I11: "an implementation element too short",
  I12: "an implementation pattern match failure",
  I13: "an implementation dependent 'not used' element present",
};

/** 999 IK5/AK9 status. */
export const ACK_STATUSES: Record<string, string> = {
  A: "accepted",
  E: "accepted with errors",
  M: "rejected: message authentication code failed",
  P: "partially accepted",
  R: "rejected",
  W: "rejected: assurance failed validity tests",
  X: "rejected: content could not be analysed after decryption",
};

/** TA105: what was wrong with the interchange. */
export const TA1_NOTES: Record<string, string> = {
  "000": "No error",
  "001": "The interchange control numbers in the header and trailer do not match",
  "002": "This standard as noted in the control standards identifier is not supported",
  "003": "This version of the controls is not supported",
  "004": "The segment terminator is invalid",
  "005": "Invalid interchange ID qualifier for the sender",
  "006": "Invalid interchange sender ID",
  "007": "Invalid interchange ID qualifier for the receiver",
  "008": "Invalid interchange receiver ID",
  "009": "Unknown interchange receiver ID",
  "010": "Invalid authorization information qualifier value",
  "011": "Invalid authorization information value",
  "012": "Invalid security information qualifier value",
  "013": "Invalid security information value",
  "014": "Invalid interchange date value",
  "015": "Invalid interchange time value",
  "016": "Invalid interchange standards identifier value",
  "017": "Invalid interchange version ID value",
  "018": "Invalid interchange control number value",
  "019": "Invalid acknowledgment requested value",
  "020": "Invalid test indicator value",
  "021": "Invalid number of included groups value",
  "022": "Invalid control structure",
  "023": "Improper (premature) end-of-file",
  "024": "Invalid interchange content (e.g. invalid GS segment)",
  "025": "Duplicate interchange control number",
  "026": "Invalid data element separator",
  "027": "Invalid component element separator",
  "028": "Invalid delivery date in deferred delivery request",
  "029": "Invalid delivery time in deferred delivery request",
  "030": "Invalid delivery time code in deferred delivery request",
  "031": "Invalid grade of service code",
};

/** 271 AAA03: why the payer could not answer about the patient. */
export const ELIGIBILITY_ERRORS: Record<string, string> = {
  "15": "Required information is missing",
  "33": "The request had input errors",
  "41": "Authorization or access restrictions",
  "42": "The payer cannot respond right now — try again later",
  "43": "The provider's ID is invalid or missing",
  "44": "The provider's name is invalid or missing",
  "50": "The provider is not eligible to ask",
  "51": "The provider is not on file with the payer",
  "52": "The date is outside the provider's enrollment",
  "56": "The date is not appropriate",
  "57": "The date of service is invalid or missing",
  "58": "The date of birth is invalid or missing",
  "60": "The date of birth is after the date of service",
  "61": "The date of death is before the date of service",
  "62": "The date is outside the period the payer answers for",
  "63": "The date of service is in the future",
  "64": "The patient ID is invalid or missing",
  "65": "The patient name is invalid or missing",
  "66": "The patient's gender is invalid or missing",
  "67": "The patient was not found",
  "68": "The patient ID is a duplicate",
  "71": "The date of birth does not match the payer's record",
  "72": "The member ID is invalid or missing",
  "73": "The subscriber's name is invalid or missing",
  "74": "The subscriber's gender is invalid or missing",
  "75": "The subscriber was not found",
  "76": "The member ID is a duplicate",
  "77": "The subscriber was found but the patient was not",
  "78": "The subscriber is not in the group or plan named",
  "79": "Invalid participant identification",
  "80": "No response received — the request ended",
  "97": "The provider's address is invalid or missing",
  T4: "The payer name or ID is missing",
};

/** 271 EB01: what a benefit row says. */
export const BENEFIT_INFO: Record<string, string> = {
  "1": "Active coverage",
  "2": "Active: full-risk capitation",
  "3": "Active: services capitated",
  "4": "Active: capitated to the primary care physician",
  "5": "Active: pending investigation",
  "6": "Inactive",
  "7": "Inactive: pending eligibility update",
  "8": "Inactive: pending investigation",
  A: "Coinsurance",
  B: "Copay",
  C: "Deductible",
  CB: "Coverage basis",
  D: "Benefit description",
  E: "Exclusions",
  F: "Limitations",
  G: "Out-of-pocket maximum",
  H: "Unlimited",
  I: "Not covered",
  J: "Cost containment",
  L: "Primary care provider",
  MC: "Managed care coordinator",
  N: "Services restricted to the provider named",
  P: "Benefit disclaimer",
  R: "Other or additional payer",
  U: "Contact the entity named for eligibility",
  V: "Cannot process",
  W: "Other source of data",
  X: "Health care facility",
  Y: "Spend down",
};

/** 271 EB03 / 270 EQ01: the service types a palliative practice asks about. */
export const SERVICE_TYPES: Record<string, string> = {
  "1": "Medical care",
  "30": "Health benefit plan coverage",
  "42": "Home health care",
  "45": "Hospice",
  "47": "Hospital",
  "48": "Hospital inpatient",
  "50": "Hospital outpatient",
  "86": "Emergency services",
  "88": "Pharmacy",
  "96": "Professional (physician)",
  "98": "Professional (physician) visit — office",
  "99": "Professional (physician) visit — inpatient",
  A3: "Professional (physician) visit — home",
  A6: "Psychotherapy",
  BY: "Physician visit — office: sick",
  MH: "Mental health",
  UC: "Urgent care",
};

/** 271 EB04 / 837 SBR09 neighbours: the insurance types a 271 names. */
export const INSURANCE_TYPES: Record<string, string> = {
  C1: "Commercial",
  CO: "COBRA",
  EP: "Exclusive provider organization",
  GP: "Group policy",
  HM: "HMO",
  HN: "HMO — Medicare risk (Medicare Advantage)",
  IN: "Indemnity",
  MA: "Medicare Part A",
  MB: "Medicare Part B",
  MC: "Medicaid",
  MH: "Medigap Part A",
  MI: "Medigap Part B",
  MP: "Medicare primary",
  OT: "Other",
  PR: "PPO",
  PS: "Point of service",
  QM: "Qualified Medicare beneficiary",
  SP: "Supplemental policy",
  WC: "Workers' compensation",
};

/** One status in a sentence: "Rejected for invalid information — Subscriber and subscriber ID not found (33)". */
export function describeStatus(st: { category: string; code: string; entity?: string; message?: string }): string {
  const cat = STATUS_CATEGORIES[st.category] ?? `Status ${st.category}`;
  const label = st.code ? STATUS_CODES[st.code] ?? "Status code" : "";
  // A2:20 says "accepted for processing" twice; once is enough.
  const code = !st.code ? "" : label.toLowerCase() === cat.toLowerCase() ? ` (${st.code})` : ` — ${label} (${st.code})`;
  const entity = st.entity && STATUS_ENTITIES[st.entity] ? ` — about ${STATUS_ENTITIES[st.entity]}` : "";
  const msg = st.message ? `: ${st.message}` : "";
  return `${cat}${code}${entity}${msg}`;
}

/** The 837P's loops, as the parts of a claim a biller knows them by. */
const LOOP_SUBJECTS: Record<string, string> = {
  "1000A": "submitter",
  "1000B": "receiver",
  "2000A": "billing provider",
  "2010AA": "billing provider",
  "2010AB": "pay-to address",
  "2000B": "subscriber's insurance",
  "2010BA": "subscriber",
  "2010BB": "payer",
  "2000C": "patient",
  "2010CA": "patient",
  "2300": "claim",
  "2310B": "rendering provider",
  "2310C": "service location",
  "2400": "service line",
};

/** An element of an 837P segment as the field it holds, where that is clear; null otherwise. */
function fieldName(segment: string, pos: string, loop: string): string | null {
  const person = loop === "2010BA" || loop === "2010CA" || loop === "2310B";
  switch (segment) {
    case "NM1":
      if (pos === "03") return person ? "last name" : "name";
      if (pos === "04") return "first name";
      if (pos === "08") return "ID type";
      if (pos !== "09") return null;
      if (loop === "2010BA" || loop === "2010CA") return "member ID";
      if (loop === "2010BB") return "payer ID";
      if (loop === "1000A") return "submitter ID";
      if (loop === "1000B") return "receiver ID";
      return "NPI";
    case "N3":
      return "street address";
    case "N4":
      return pos === "01" ? "city" : pos === "02" ? "state" : pos === "03" ? "ZIP code" : "address";
    case "DMG":
      return pos === "02" ? "date of birth" : pos === "03" ? "sex" : null;
    case "REF":
      if (loop === "2010AA" || loop === "2010AB") return "tax ID (EIN)";
      if (loop === "2300") return "original claim number";
      if (loop === "2400") return "line reference";
      return null;
    case "PRV":
      return pos === "03" ? "taxonomy code" : null;
    case "SBR":
      return pos === "03" ? "group number" : pos === "09" ? "claim filing indicator" : null;
    case "CLM":
      return pos === "01" ? "Claim ref" : pos === "02" ? "total charge" : pos === "05" ? "place of service or claim frequency" : null;
    case "HI":
      return "diagnosis code";
    case "SV1":
      return pos === "01" ? "procedure code or modifier" : pos === "02" ? "charge" : pos === "04" ? "unit count" : pos === "07" ? "diagnosis pointer" : null;
    case "DTP":
      return loop === "2400" ? "service date" : "date";
    case "PER":
      return "contact information";
    default:
      return null;
  }
}

/** 999 IK403, as what is wrong with the field. */
const ELEMENT_PROBLEMS: Record<string, string> = {
  "1": "is missing",
  "2": "is missing",
  "3": "has too many parts",
  "4": "is too short",
  "5": "is too long",
  "6": "has characters that aren't allowed",
  "7": "has a value that isn't valid",
  "8": "has a date that isn't valid",
  "9": "has a time that isn't valid",
  "10": "shouldn't be there",
  "12": "repeats too many times",
  "13": "has too many parts",
  I6: "has a value this clearinghouse doesn't accept",
  I9: "is missing",
  I10: "shouldn't be there",
  I11: "is too short",
  I12: "isn't in the expected format",
  I13: "shouldn't be there",
};

/** 999 IK304, for a segment error that names no element. */
const SEGMENT_PROBLEMS: Record<string, string> = {
  "1": "isn't recognised",
  "2": "isn't expected there",
  "3": "is missing",
  "4": "repeats too many times",
  "5": "repeats too many times",
  "6": "isn't expected there",
  "7": "is out of order",
  "8": "has an error",
  I4: "isn't expected there",
  I6: "is missing",
  I7: "repeats too many times",
  I8: "is incomplete",
  I9: "isn't expected there",
};

type AckErrorLike = { segment: string; position: string; loop: string; code: string; elements: { position: string; code: string }[] };

const elementPos = (e: AckErrorLike): string | null => {
  const p = e.elements[0]?.position ?? "";
  return /^\d+$/.test(p) ? p.padStart(2, "0") : null;
};

function fieldPhrase(subject: string, field: string): string {
  if (field === "Claim ref") return "The Claim ref";
  if (subject === "service line") return `A service line's ${field}`;
  if (subject === "subscriber's insurance") return `The subscriber's ${field}`;
  if (subject === "pay-to address") return `The pay-to ${field}`;
  if (field === `${subject} ID`) return `The ${field}`;
  return `The ${subject}'s ${field}`;
}

/**
 * One 999 error, said plainly, with where it sits for whoever calls the
 * clearinghouse: "The subscriber's member ID has a value that isn't valid
 * (NM1-09, loop 2010BA)".
 */
export function describeAckError(e: AckErrorLike): string {
  const subject = LOOP_SUBJECTS[e.loop] ?? null;
  const pos = elementPos(e);
  const ref = `${e.segment}${pos ? `-${pos}` : ""}${e.loop ? `, loop ${e.loop}` : ""}`;
  const el = e.elements[0];
  if (!el) {
    const what = SEGMENT_PROBLEMS[e.code] ?? "has an error";
    return `${subject ? `Part of the ${subject} details` : `The ${e.segment} segment`} ${what} (${ref})`;
  }
  const field = pos ? fieldName(e.segment, pos, e.loop) : null;
  const thing = field && subject ? fieldPhrase(subject, field) : subject ? `A ${subject} field` : "A field";
  const more = e.elements.length > 1 ? `, and ${e.elements.length - 1} more in the same place` : "";
  return `${thing} ${ELEMENT_PROBLEMS[el.code] ?? "has an error"} (${ref})${more}`;
}

/** Where each kind of rejected detail is put right, for the bill page's "What to do". */
export const NEXT_STEPS = {
  insurance: "Fix the member ID or plan on the patient's chart (Insurance), click “Update insurance from chart” on this bill, then send it again.",
  identity: "Fix it on the patient's chart (Identity), then send the claim again.",
  payerId: "Check this payer's ID in Settings → Integrations → Payer IDs, then send the claim again.",
  billing: "Fix it in Settings → Billing provider, then send the claim again.",
  team: "Fix the clinician's NPI or taxonomy on the Team page, then send the claim again.",
  bill: "Fix it on this bill, then send the claim again.",
  connection: "Check the connection's IDs in Settings → Integrations, or ask the clearinghouse what it expects, then send the claim again.",
  wholeFile: "The clearinghouse turned the whole file down before reading any claim. Check the connection in Settings → Integrations, or ask the clearinghouse, then send the claims again.",
  duplicate: "The payer already has this claim. Don't send it again; check its status instead.",
  enrollment: "The payer doesn't have this provider or submitter on file for electronic claims. Finish enrollment with the payer or the clearinghouse, then send the claim again.",
  other: "Fix what the payer named, then send the claim again.",
} as const;

/** What to do about a 999 error, by the part of the claim it names. */
export function ackErrorNextStep(e: AckErrorLike): string {
  const pos = elementPos(e);
  const field = pos ? fieldName(e.segment, pos, e.loop) : null;
  switch (LOOP_SUBJECTS[e.loop]) {
    case "subscriber":
    case "patient":
      return field === "member ID" ? NEXT_STEPS.insurance : NEXT_STEPS.identity;
    case "subscriber's insurance":
      return NEXT_STEPS.insurance;
    case "payer":
      return NEXT_STEPS.payerId;
    case "billing provider":
    case "pay-to address":
      return NEXT_STEPS.billing;
    case "rendering provider":
      return NEXT_STEPS.team;
    case "claim":
    case "service line":
    case "service location":
      return NEXT_STEPS.bill;
    default:
      return NEXT_STEPS.connection;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A payer's rejection, said plainly: the code's own words with the entity it
 * is about put in ("The billing provider's National Provider Identifier (NPI)
 * not on file"), the codes for whoever calls, and the payer's own note.
 */
export function plainStatus(st: { category: string; code: string; entity?: string; message?: string }): string {
  const entity = st.entity ? STATUS_ENTITIES[st.entity] : undefined;
  let words = (st.code && STATUS_CODES[st.code]) || STATUS_CATEGORIES[st.category] || `Status ${st.category}`;
  if (entity && /^Entity('s)?\b/.test(words)) {
    words = words.replace(/^Entity('s)?/, (_m, s: string | undefined) => `${capitalize(entity)}${s ?? ""}`);
  }
  const codes = st.code ? `${st.category}:${st.code}` : st.category;
  return `${words} (${codes})${st.message ? `. Payer's note: “${st.message}”` : ""}`;
}

/** What to do about a payer's rejection (277CA), from what it is about. */
export function rejectionNextStep(st: { category: string; code: string; entity?: string }): string {
  const code = st.code;
  const entity = st.entity ?? "";
  if (["686", "688"].includes(code)) return NEXT_STEPS.duplicate;
  if (["24", "25", "496", "562"].includes(code)) return NEXT_STEPS.enrollment;
  if (["IL", "QC", "03"].includes(entity) || ["29", "30", "31", "32", "33", "97", "673", "674"].includes(code)) return NEXT_STEPS.insurance;
  if (["85", "87"].includes(entity) || ["85", "86", "92", "128", "709"].includes(code)) return NEXT_STEPS.billing;
  if (entity === "82" || code === "460") return NEXT_STEPS.team;
  if (entity === "PR" || code === "116") return NEXT_STEPS.payerId;
  if (["35", "38", "44", "45", "48", "52", "53", "54", "57", "62", "187", "189", "210", "249", "255", "400", "454", "516", "545"].includes(code)) {
    return NEXT_STEPS.bill;
  }
  return NEXT_STEPS.other;
}
