/**
 * The eligibility answer (0120): a 271 (005010X279A1), read into what the
 * chart's coverage checks show — is the patient covered, under which plan,
 * from when to when, what they pay, and whether the payer reports a hospice
 * election (service type 45), which changes how a palliative visit is billed.
 *
 * Pure. The summary keeps no name, member ID or date of birth: the coverage
 * check row already holds the member ID it asked about, and the rest is not
 * needed to read the answer. Entity names kept are organisations (the
 * hospice, another payer), never people.
 */
import { cents, el, isoDay, isoDayEnd, readX12, reps, X12ReadError, type X12Document, type X12Segment } from "./x12-read";

export interface EligibilityError {
  /** Where the payer raised it: about itself, the provider, the patient, or one benefit. */
  level: "payer" | "provider" | "subscriber" | "benefit";
  /** AAA03: 72 invalid member ID, 75 not found, 42 unable to respond … */
  code: string;
  /** AAA04: C correct and resubmit, N do not resubmit, R resubmit allowed … */
  followUp: string;
}

export interface EligibilityEntity {
  /** NM101: PR payer, 1P provider, P3 primary care provider, X3 utilisation … */
  role: string;
  name: string | null;
  npi: string | null;
}

export interface EligibilityBenefit {
  /** EB01: 1 active, 6 inactive, A coinsurance, B copay, C deductible, R other payer, X facility … */
  info: string;
  /** EB02: IND, FAM … */
  coverageLevel: string;
  /** EB03: service types (30 plan coverage, 98 office visit, A3 home visit, 45 hospice …). */
  serviceTypes: string[];
  /** EB04: MA, MB, MC, C1, HM, HN … */
  insuranceType: string;
  /** EB05. */
  description: string;
  /** EB06. */
  timePeriod: string;
  amountCents: number | null;
  /** EB08 as a percentage (0.2 → 20). */
  percent: number | null;
  /** EB12: Y in network, N out, W not applicable, U unknown. */
  inNetwork: string;
  from: string | null;
  to: string | null;
  messages: string[];
  entities: EligibilityEntity[];
}

export interface EligibilitySummary {
  payerName: string | null;
  /** active / inactive from the EB01s; unknown when the payer gave neither (or errors). */
  coverage: "active" | "inactive" | "unknown";
  errors: EligibilityError[];
  planDescription: string | null;
  insuranceType: string | null;
  groupNumber: string | null;
  groupName: string | null;
  planBegin: string | null;
  planEnd: string | null;
  eligibilityBegin: string | null;
  eligibilityEnd: string | null;
  benefits: EligibilityBenefit[];
  /** Hospice elections on file (isHospiceElection). */
  hospice: EligibilityBenefit[];
  /** EB*R: another payer the patient has (a Medicare Advantage plan, a secondary). */
  otherPayers: { name: string | null; insuranceType: string }[];
  messages: string[];
}

const ACTIVE = new Set(["1", "2", "3", "4", "5"]);
const INACTIVE = new Set(["6", "7", "8"]);

/**
 * A hospice election on file. Medicare's answer (HETS) gives each hospice
 * benefit period as EB01 "X" (health care facility) for service type 45, with
 * its dates (DTP*292) and the hospice (NM1*1P). A line that lists 45 among
 * the services a plan covers (EB*1**30^…^45) says the plan pays for hospice
 * care, not that this patient elected it, and is not one.
 */
export const isHospiceElection = (b: EligibilityBenefit): boolean => b.info === "X" && b.serviceTypes.includes("45");

/** "from 2026-10-01 to 2026-12-29 (St. Mary's Hospice)", for the chart and the check's note. */
export function hospiceElectionText(b: EligibilityBenefit): string {
  const name = b.entities.find((e) => e.role === "1P")?.name ?? b.entities[0]?.name ?? null;
  return [b.from && `from ${b.from}`, b.to && `to ${b.to}`, name && `(${name})`].filter(Boolean).join(" ") || "dates not given";
}

function aaa(s: X12Segment, level: EligibilityError["level"]): EligibilityError {
  return { level, code: el(s, 3), followUp: el(s, 4) };
}

function dtp(s: X12Segment): { qual: string; from: string | null; to: string | null } {
  return { qual: el(s, 1), from: isoDay(el(s, 3)), to: isoDayEnd(el(s, 3)) };
}

export function parse271(input: string | X12Document): EligibilitySummary {
  const doc = typeof input === "string" ? readX12(input) : input;
  if (!doc.transactionTypes.includes("271")) throw new X12ReadError("This is not a 271 eligibility response.");
  const out: EligibilitySummary = {
    payerName: null,
    coverage: "unknown",
    errors: [],
    planDescription: null,
    insuranceType: null,
    groupNumber: null,
    groupName: null,
    planBegin: null,
    planEnd: null,
    eligibilityBegin: null,
    eligibilityEnd: null,
    benefits: [],
    hospice: [],
    otherPayers: [],
    messages: [],
  };
  let level = "";
  let benefit: EligibilityBenefit | null = null;
  let inEntityLoop = false;
  let entity: EligibilityEntity | null = null;
  for (const s of doc.segments) {
    switch (s.tag) {
      case "HL":
        level = el(s, 3);
        benefit = null;
        inEntityLoop = false;
        entity = null;
        break;
      case "NM1":
        if (inEntityLoop && benefit) {
          entity = { role: el(s, 1), name: el(s, 2) === "2" ? el(s, 3) || null : null, npi: el(s, 8) === "XX" ? el(s, 9) || null : null };
          benefit.entities.push(entity);
        } else if (level === "20" && el(s, 1) === "PR") {
          out.payerName = el(s, 3) || null;
        }
        break;
      case "AAA":
        if (benefit) out.errors.push(aaa(s, "benefit"));
        else if (level === "20") out.errors.push(aaa(s, "payer"));
        else if (level === "21") out.errors.push(aaa(s, "provider"));
        else out.errors.push(aaa(s, "subscriber"));
        break;
      case "REF":
        if (!benefit && (level === "22" || level === "23")) {
          if (el(s, 1) === "6P") {
            out.groupNumber = el(s, 2) || null;
            out.groupName = el(s, 3) || null;
          }
        }
        break;
      case "DTP": {
        const d = dtp(s);
        if (benefit) {
          // A start (292 benefit period, 291 plan, 346 plan begin, 348 benefit
          // begin, 356 eligibility begin, 193 period start) — a range (RD8)
          // gives the end too — or an end (347, 349, 357, 194).
          if (["292", "291", "346", "348", "356", "193"].includes(d.qual)) {
            benefit.from = d.from;
            if (el(s, 2) === "RD8") benefit.to = d.to;
          } else if (["347", "349", "357", "194"].includes(d.qual)) {
            benefit.to = d.from;
          }
        } else if (level === "22" || level === "23") {
          if (d.qual === "346") out.planBegin = d.from;
          else if (d.qual === "347") out.planEnd = d.from;
          else if (d.qual === "356") out.eligibilityBegin = d.from;
          else if (d.qual === "357") out.eligibilityEnd = d.from;
          else if (d.qual === "291" || d.qual === "307") {
            // A plan or eligibility range given as one date pair.
            out.planBegin ??= d.from;
            if (d.to && d.to !== d.from) out.planEnd ??= d.to;
          }
        }
        break;
      }
      case "EB":
        inEntityLoop = false;
        entity = null;
        benefit = {
          info: el(s, 1),
          coverageLevel: el(s, 2),
          serviceTypes: reps(doc, s, 3),
          insuranceType: el(s, 4),
          description: el(s, 5),
          timePeriod: el(s, 6),
          amountCents: cents(el(s, 7)),
          percent: el(s, 8).trim() === "" ? null : Math.round(Number(el(s, 8)) * 10000) / 100,
          inNetwork: el(s, 12),
          from: null,
          to: null,
          messages: [],
          entities: [],
        };
        out.benefits.push(benefit);
        break;
      case "MSG":
        if (benefit) benefit.messages.push(el(s, 1));
        else out.messages.push(el(s, 1));
        break;
      case "LS":
        inEntityLoop = true;
        break;
      case "LE":
        inEntityLoop = false;
        entity = null;
        break;
      case "SE":
        level = "";
        benefit = null;
        inEntityLoop = false;
        break;
    }
  }
  // Coverage: active when any benefit says so; inactive when only inactive ones do.
  if (out.benefits.some((b) => ACTIVE.has(b.info))) out.coverage = "active";
  else if (out.benefits.some((b) => INACTIVE.has(b.info))) out.coverage = "inactive";
  const plan =
    out.benefits.find((b) => ACTIVE.has(b.info) && b.serviceTypes.includes("30")) ??
    out.benefits.find((b) => ACTIVE.has(b.info));
  if (plan) {
    out.planDescription = plan.description || null;
    out.insuranceType = plan.insuranceType || null;
    out.planBegin ??= plan.from;
    out.planEnd ??= plan.to !== plan.from ? plan.to : null;
  }
  out.hospice = out.benefits.filter(isHospiceElection);
  out.otherPayers = out.benefits
    .filter((b) => b.info === "R")
    .map((b) => ({ name: b.entities.find((e) => e.role === "PR")?.name ?? null, insuranceType: b.insuranceType }));
  return out;
}

/**
 * The coverage check row's result (insurance_verification.result, 0111):
 * active, inactive, not_found when the payer could not find the member, and
 * pending when it could not answer (42 unable to respond …).
 */
export function verificationResult(s: EligibilitySummary): "active" | "inactive" | "not_found" | "pending" {
  if (s.coverage === "active") return "active";
  if (s.coverage === "inactive") return "inactive";
  const notFound = new Set(["67", "72", "73", "75", "76", "77", "78", "64", "65", "71"]);
  if (s.errors.some((e) => notFound.has(e.code))) return "not_found";
  return "pending";
}
