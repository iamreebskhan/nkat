/**
 * The risk score and the payer's documentation standard (audit R19).
 *
 * The predictor reads the note through the saved bill when there is one, and
 * through the visit before the bill exists. Without the second path, the risk
 * stored when a draft is created at sign-off never carried the gap: only the
 * previews a biller ran later did.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("../denial-feedback.service", () => ({ getDenialRuleMetrics: vi.fn(async () => ({})) }));

import { withOrgContext } from "@/lib/db";

import { predictSuperbill } from "../predict-superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PAYER = "a0000000-0000-4000-8000-000000000302";
/** Another payer with rules of its own for the same state and code. */
const OTHER_PAYER = "a0000000-0000-4000-8000-000000000401";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
const SB = "ba011b2d-64cc-48b5-b4d9-2d3a302a73ce";

/**
 * A note with no chief complaint, against UHC Community Plan Ohio's standard.
 * dos is the saved bill's date of service (a DATE), as the read through the
 * bill selects it.
 */
const facts = {
  is_telehealth: false, telehealth_modality: null, total_minutes: 45, dx_count: 1,
  dos: new Date("2026-09-09T00:00:00Z"), state: "OH", payer_id: PAYER,
  payer_name: "UnitedHealthcare Community Plan Ohio", codes: ["99349"],
  filled_keys: ["hpi", "physical_exam", "assessment_and_plan"],
  template_keys: ["chief_complaint", "hpi", "vitals", "physical_exam", "assessment_and_plan"],
  has_vitals: true,
};
const ELEMENTS = ["vitals", "chief_complaint", "physical_exam", "diagnosis", "plan"];

/**
 * The read through the visit, answered per statement as a UTC session (CI)
 * would. The date of service is the visit's latest bill's (a DATE), NULL while
 * it has none; a ::date cast is the instant's UTC day; the instant and the
 * org's zone come back only when selected.
 */
const visitRead =
  (visitAt: Date | null, billDos: Date | null = null) =>
  (sql: string): Record<string, unknown> => {
    const row: Record<string, unknown> = { ...facts };
    if (/\blb\.date_of_service AS dos\b/.test(sql)) row.dos = billDos;
    else if (/COALESCE\(dv\.start_time, dv\.scheduled_start\)::date AS dos\b/.test(sql)) {
      row.dos = visitAt ? new Date(`${visitAt.toISOString().slice(0, 10)}T00:00:00Z`) : null;
    } else throw new Error("the facts query selected no dos this fake can evaluate");
    if (/COALESCE\(dv\.start_time, dv\.scheduled_start\) AS visit_at\b/.test(sql)) row.visit_at = visitAt;
    if (/\bo\.timezone AS org_timezone\b/.test(sql) && /\bJOIN org o ON o\.id = dv\.org_id\b/.test(sql)) {
      row.org_timezone = "America/New_York";
    }
    return row;
  };

let calls: { sql: string; values: unknown[] }[] = [];
/**
 * The visit read's answer. By default a visit with no bill yet, started at
 * 11 am EDT on the 9th, base's day: the tests read "before the bill is saved"
 * and have to model exactly that.
 */
let visitFacts: (sql: string) => Record<string, unknown>;

interface Rule {
  payer_id: string;
  state: string;
  code: string;
  coverage_status: "covered" | "not_covered" | "varies" | "unknown";
  confidence: string;
  modifier_required: boolean;
  prior_auth_required: boolean;
  has_frequency_limit: boolean;
  frequency_limit_value: string | null;
  payer_rule_id: string;
}

const rule = (o: Partial<Rule> & { payer_rule_id: string }): Rule => ({
  payer_id: PAYER, state: "OH", code: "99349", coverage_status: "covered", confidence: "0.85",
  modifier_required: false, prior_auth_required: false,
  has_frequency_limit: false, frequency_limit_value: null,
  ...o,
});

/**
 * What payer_allowed_codes_v holds — ROWS, not one answer.
 *
 * The view is global reference data with no RLS, so this read's WHERE clause is
 * the only thing keeping a draft from being scored against another payer's
 * rules; withOrgContext would not catch it. Answered by one fixed row whatever
 * it asked for, the payer predicate, the state predicate and the whole WHERE
 * could each be deleted with 6/6 green. The collision below is the real one in
 * the reference data (in the local view, NC/36415 is not_covered for
 * Traditional Medicare Part B and covered for five other payers), moved onto
 * the code this spec scores.
 */
let rules: Rule[];

/** `text` split on `sep` where it is not inside parentheses. */
function splitOutsideParens(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(from, i).trim());
      from = i + sep.length;
      i = from - 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

/** The value bound at the `¶` inside the first match of `re`, or undefined. */
function boundIn(call: { sql: string; values: unknown[] }, re: RegExp): unknown {
  const m = re.exec(call.sql);
  if (!m) return undefined;
  const at = m.index + m[0].indexOf("¶");
  return call.values[call.sql.slice(0, at).split("¶").length - 1];
}

/**
 * The rules the read asks for, decided by EVALUATING its WHERE clause against
 * the rows above — never by restating the clause here, which is how it came to
 * be unverified. A predicate dropped from the SQL is dropped here too, so the
 * scoring changes and the tests below go red. Only the atoms this statement
 * uses are understood; anything else throws rather than being guessed at.
 */
function rulesMatching(sql: string, values: unknown[]): Rule[] {
  const start = sql.indexOf("WHERE ") + "WHERE ".length;
  let next = sql.slice(0, start).split("¶").length - 1;
  const take = () => values[next++];
  const atom = (text: string): ((r: Rule) => boolean) => {
    const col = (name: string): keyof Rule => {
      if (!(name in rule({ payer_rule_id: "" }))) throw new Error(`no view column "${name}"`);
      return name as keyof Rule;
    };
    let m: RegExpExecArray | null;
    if (/^TRUE$/i.test(text)) return () => true;
    if ((m = /^(\w+)\s*= ANY\(¶(?:::\w+(?:\[\])?)?\)$/.exec(text))) {
      const c = col(m[1]!);
      const list = take() as unknown[];
      return (r) => list.includes(r[c]);
    }
    if ((m = /^(\w+)\s*= ¶(?:::\w+)?$/.exec(text))) {
      const c = col(m[1]!);
      const value = take();
      return (r) => r[c] === value;
    }
    throw new Error(`the fake cannot evaluate the coverage read's clause: ${text}`);
  };
  const clauses = splitOutsideParens(
    sql.slice(start).replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim(),
    " AND ",
  ).map((clause) => {
    if (!clause.startsWith("(")) return atom(clause);
    const either = splitOutsideParens(clause.slice(1, -1), " OR ").map(atom);
    return (r: Rule) => either.some((p) => p(r));
  });
  return rules.filter((r) => clauses.every((p) => p(r)));
}

/**
 * The patient's earlier bill lines, one per code, as the frequency check reads
 * them. The read is answered by applying ITS OWN binds: the day it starts
 * from, the patient, and the org when it names one (a statement that does not
 * reads every org's rows, as on a connection that bypasses RLS).
 */
let history: { org_id: string; patient_id: string; code: string; dos: string }[];

function historyRead(sql: string, values: unknown[]) {
  const call = { sql, values };
  const since = boundIn(call, /date_of_service >= ¶/);
  const org = boundIn(call, /\borg_id = ¶/);
  const patient = boundIn(call, /\bpatient_id = ¶/);
  if (typeof since !== "string") throw new Error("the history read binds no start day this fake can apply");
  return history
    .filter((h) => (org === undefined || h.org_id === org) && h.patient_id === patient && h.dos >= since)
    .map((h) => ({ code: h.code, dos: new Date(`${h.dos}T00:00:00Z`) }));
}

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM payer_allowed_codes_v")) {
      return Promise.resolve(rulesMatching(sql, values));
    }
    if (/FROM superbill\s+WHERE/.test(sql)) return Promise.resolve(historyRead(sql, values));
    if (sql.includes("FROM visit dv")) return Promise.resolve([visitFacts(sql)]);
    if (sql.includes("FROM superbill sb")) return Promise.resolve([facts]);
    if (sql.includes("FROM documentation_requirement")) {
      // One requirement row per code asked for.
      return Promise.resolve((values[0] as string[]).map((code) => ({ code, required_chart_elements: ELEMENTS })));
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  history = [];
  visitFacts = visitRead(new Date("2026-09-09T15:00:00Z"));
  rules = [
    // The draft's own payer, in the draft's own state.
    rule({ payer_rule_id: "this-payer-oh" }),
    // The same code in the same state, ruled on by ANOTHER payer — and listed
    // after, as the view may return it: rulesByCode is keyed by code alone and
    // last write wins, so whichever row arrives last decides the score.
    rule({
      payer_rule_id: "other-payer-oh", payer_id: OTHER_PAYER,
      coverage_status: "not_covered", prior_auth_required: true,
    }),
    // The same payer and code in another state.
    rule({
      payer_rule_id: "this-payer-nc", state: "NC",
      coverage_status: "not_covered", prior_auth_required: true,
    }),
  ];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const base = { orgId: ORG, payerId: PAYER, state: "OH", patientId: "p1", dos: "2026-09-09", cptCodes: ["99349"] };
const reasonCodes = (r: Awaited<ReturnType<typeof predictSuperbill>>) =>
  r.perLine.flatMap((p) => p.reasons.map((x) => x.code));
const read = (fragment: string) => calls.find((c) => c.sql.includes(fragment));

describe("predictSuperbill — payer documentation", () => {
  it("reads a saved bill's note through the bill", async () => {
    const r = await predictSuperbill({ ...base, excludeSuperbillId: SB });
    expect(reasonCodes(r)).toContain("documentation_incomplete");
    expect(read("FROM superbill sb")!.values).toContain(SB);
    expect(read("FROM visit dv")).toBeUndefined();
  });

  it("reads the visit's note before the bill is saved, as draft creation does", async () => {
    const r = await predictSuperbill({ ...base, visitId: VISIT });
    expect(reasonCodes(r)).toContain("documentation_incomplete");
    expect(read("FROM visit dv")!.values).toContain(VISIT);
    const reason = r.perLine[0]!.reasons.find((x) => x.code === "documentation_incomplete")!;
    expect(reason.message).toContain("Chief complaint");
  });

  it("prefers the saved bill when both are given", async () => {
    await predictSuperbill({ ...base, excludeSuperbillId: SB, visitId: VISIT });
    expect(read("FROM visit dv")).toBeUndefined();
  });

  it("checks the codes being scored, which may not be saved yet", async () => {
    await predictSuperbill({ ...base, cptCodes: ["99350"], visitId: VISIT });
    expect(read("FROM documentation_requirement")!.values).toContainEqual(["99350"]);
  });

  it("flags a code with no coverage rule too, alongside coverage_unknown", async () => {
    const r = await predictSuperbill({ ...base, cptCodes: ["99350"], visitId: VISIT });
    expect(r.perLine[0]!.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["coverage_unknown", "documentation_incomplete"]),
    );
  });

  it("reads no standard when neither a bill nor a visit is named", async () => {
    const r = await predictSuperbill({ ...base });
    expect(read("FROM documentation_requirement")).toBeUndefined();
    expect(reasonCodes(r)).not.toContain("documentation_incomplete");
  });
});

/**
 * The risk stored at sign-off checks the note on the draft's own date of
 * service. Before the bill is saved the visit read has no bill date, so the
 * day came from casting the visit's instant in the database session's zone
 * (UTC in CI, Karachi here): an evening visit's note was checked against the
 * next day's payer standard, and a visit with no recorded time — whose draft
 * took today's date — was not checked at all.
 */
describe("predictSuperbill — the documentation check runs on the date being scored", () => {
  const requirementDates = () =>
    read("FROM documentation_requirement")?.values.filter((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));

  it("CONTROL: an 8:30 pm EDT visit's draft is checked on its date of service, the 22nd", async () => {
    visitFacts = visitRead(new Date("2026-09-23T00:30:00Z"));
    await predictSuperbill({ ...base, dos: "2026-09-22", visitId: VISIT });
    expect(requirementDates()).toEqual(["2026-09-22", "2026-09-22"]);
  });

  it("CONTROL: a visit with no recorded time is still checked, on the date its draft carries", async () => {
    visitFacts = visitRead(null);
    const r = await predictSuperbill({ ...base, dos: "2026-09-22", visitId: VISIT });
    expect(requirementDates()).toEqual(["2026-09-22", "2026-09-22"]);
    expect(reasonCodes(r)).toContain("documentation_incomplete");
  });

  it("a billed visit is checked on its bill's date, not the day being scored", async () => {
    // A bill saved before 0107, dated the evening visit's UTC day, the 10th,
    // previewed through the visit with the practice's day, the 9th. The claim
    // carries the 10th, and the submit gate checks it on the 10th.
    visitFacts = visitRead(new Date("2026-09-10T00:30:00Z"), new Date("2026-09-10T00:00:00Z"));
    await predictSuperbill({ ...base, dos: "2026-09-09", visitId: VISIT });
    expect(requirementDates()).toEqual(["2026-09-10", "2026-09-10"]);
  });
});

describe("predictSuperbill — whose coverage rules the draft is scored against", () => {
  /** The rule row each reason was drawn from — which row actually decided. */
  const ruleIds = (r: Awaited<ReturnType<typeof predictSuperbill>>) =>
    r.perLine.flatMap((p) => p.reasons.map((x) => x.payerRuleId)).filter(Boolean);

  it("scores the draft against its OWN payer's rule, not another payer's for the same state and code", async () => {
    const r = await predictSuperbill({ ...base });
    // The other payer calls 99349 not_covered and requires prior auth. Read
    // without the payer predicate, its row arrives last and decides: the
    // biller is shown a denial risk that belongs to a plan the patient is not
    // on — or, the other way round, a green band on a code their own payer
    // does not cover, and the claim goes out.
    expect(reasonCodes(r)).not.toContain("coverage_denied");
    expect(reasonCodes(r)).not.toContain("prior_auth_missing");
    expect(ruleIds(r)).not.toContain("other-payer-oh");
  });

  it("scores it against its own STATE's rule, not the same payer's rule in another state", async () => {
    const r = await predictSuperbill({ ...base });
    expect(ruleIds(r)).not.toContain("this-payer-nc");
    expect(r.perLine[0]!.riskBand).toBe("low");
  });

  it("CONTROL — the payer's own not_covered rule IS applied, and names the row it came from", async () => {
    rules = [rule({ payer_rule_id: "this-payer-oh", coverage_status: "not_covered" })];
    const r = await predictSuperbill({ ...base });
    const denied = r.perLine[0]!.reasons.find((x) => x.code === "coverage_denied")!;
    expect(denied.payerRuleId).toBe("this-payer-oh");
  });

  it("asks the view only for the codes being scored — a row-volume guard, not a correctness one", async () => {
    // Dropping this predicate cannot change a score (rulesByCode is keyed by
    // code, so a rule for a code the draft does not carry is never read), but
    // it turns a two-code lookup into the payer's whole schedule on every
    // keystroke-triggered preview. Asserted on the BOUND array, not on the
    // SQL's words: a predicate that loses its bind loses this assertion too.
    await predictSuperbill({ ...base, cptCodes: ["99349", "99350"] });
    const coverage = read("FROM payer_allowed_codes_v")!;
    expect(boundIn(coverage, /\bcode\s*= ANY\(¶/)).toEqual(["99349", "99350"]);
    expect(boundIn(coverage, /\bpayer_id\s*= ¶/)).toBe(PAYER);
    expect(boundIn(coverage, /\bstate\s*= ¶/)).toBe("OH");
  });
});

/**
 * The frequency history is counted back from the date of service being scored,
 * as far as the longest frequency window among the codes. It was counted back
 * 90 days from today in UTC, so a visit billed weeks later had the start of its
 * window cut off, so did any limit longer than 90 days, and the boundary moved
 * with the server's clock rather than the claim's date.
 */
describe("predictSuperbill — the frequency history behind the date of service", () => {
  const PATIENT = "p1";
  const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
  const oncePer = (windowDays: number) =>
    rule({
      payer_rule_id: "this-payer-oh",
      has_frequency_limit: true,
      frequency_limit_value: JSON.stringify({ maxOccurrences: 1, windowDays }),
    });
  const line = (dos: string, org = ORG) => ({ org_id: org, patient_id: PATIENT, code: "99349", dos });

  it("sees an earlier line anywhere in a 365-day window", async () => {
    // 192 days before the 9 Sep date of service.
    rules = [oncePer(365)];
    history = [line("2026-03-01")];
    const r = await predictSuperbill({ ...base });
    expect(reasonCodes(r)).toContain("frequency_exceeded");
  });

  it("counts back from the date of service, so a visit billed weeks later keeps its window", async () => {
    // Billing a 1 June visit: a line on 15 May is in its 90 days whatever today is.
    rules = [oncePer(90)];
    history = [line("2026-05-15")];
    const r = await predictSuperbill({ ...base, dos: "2026-06-01" });
    expect(reasonCodes(r)).toContain("frequency_exceeded");
  });

  it("reads at least the 90 days before the date of service when no window is longer", async () => {
    rules = [oncePer(30)];
    await predictSuperbill({ ...base });
    expect(boundIn(read("date_of_service >=")!, /date_of_service >= ¶/)).toBe("2026-06-11");
  });

  it("CONTROL: a line outside the rule's own window is not counted", async () => {
    rules = [oncePer(30)];
    history = [line("2026-07-01")];
    const r = await predictSuperbill({ ...base });
    expect(reasonCodes(r)).not.toContain("frequency_exceeded");
  });

  it("counts this org's lines only", async () => {
    rules = [oncePer(365)];
    history = [line("2026-08-01", OTHER_ORG)];
    const r = await predictSuperbill({ ...base });
    expect(reasonCodes(r)).not.toContain("frequency_exceeded");
    expect(boundIn(read("date_of_service >=")!, /\borg_id = ¶/)).toBe(ORG);
  });
});
