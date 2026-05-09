/**
 * Rulebook pure helpers — comparison + diff logic.
 *
 * No DB. The service layer hands two row sets (org's upload + the Pallio
 * source library) and we produce a side-by-side diff per pallio §9.4.2:
 *   - Match → green
 *   - Diff (different values) → amber
 *   - Unverified (org has, source doesn't) → gray
 *   - New from Pallio (source has, org didn't include) → blue
 */
import type {
  ComparisonOutcome,
  ComparisonRow,
  CoverageStatus,
  RulebookAttribute,
} from "./rulebook.types";

interface PartialRow {
  payerId: string | null;
  state: string;
  cptCode: string;
  attribute: RulebookAttribute;
  coverageStatus: CoverageStatus;
  ruleValue: Record<string, unknown>;
}

interface SourceRow extends PartialRow {
  sourceQuote?: string | null;
  sourcePayerRuleId?: string | null;
}

interface OrgRow extends PartialRow {}

/**
 * Comparison key — uniquely identifies a (payer, state, cpt, attribute)
 * tuple. Null payer is allowed (some org docs omit payer for "all payers"
 * rules); we match on the literal `"NULL"` token.
 */
function key(r: PartialRow): string {
  return `${r.payerId ?? "NULL"}|${r.state}|${r.cptCode}|${r.attribute}`;
}

/**
 * Diff two rule values. Returns true when both `coverageStatus` and
 * `ruleValue` semantically agree.
 *
 * Pure: no DB, no JSON.parse. Works with the same shape both sides
 * produce (the upload extractor + payer_rule view).
 */
export function rowsAgree(
  a: PartialRow,
  b: PartialRow,
): boolean {
  if (a.coverageStatus !== b.coverageStatus) return false;
  // Compare rule_value field-by-field, ignoring undefined and key order.
  const aKeys = Object.keys(a.ruleValue).filter((k) => a.ruleValue[k] !== undefined);
  const bKeys = Object.keys(b.ruleValue).filter((k) => b.ruleValue[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const av = a.ruleValue[k];
    const bv = b.ruleValue[k];
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      const aSorted = [...av].sort();
      const bSorted = [...bv].sort();
      for (let i = 0; i < aSorted.length; i++) {
        if (aSorted[i] !== bSorted[i]) return false;
      }
      continue;
    }
    if (av !== bv) return false;
  }
  return true;
}

/**
 * Build the side-by-side comparison set per §9.4.2. The output is what the
 * FE renders directly; the org admin then accepts source / keeps org / edits.
 */
export function compareRulebooks(args: {
  orgRows: OrgRow[];
  sourceRows: SourceRow[];
}): ComparisonRow[] {
  const orgByKey = new Map<string, OrgRow>();
  const srcByKey = new Map<string, SourceRow>();
  for (const r of args.orgRows) orgByKey.set(key(r), r);
  for (const r of args.sourceRows) srcByKey.set(key(r), r);

  const allKeys = new Set<string>([...orgByKey.keys(), ...srcByKey.keys()]);
  const out: ComparisonRow[] = [];

  for (const k of allKeys) {
    const org = orgByKey.get(k);
    const src = srcByKey.get(k);
    const ref = (org ?? src)!;

    let outcome: ComparisonOutcome;
    if (org && src) outcome = rowsAgree(org, src) ? "match" : "diff";
    else if (org && !src) outcome = "unverified";
    else outcome = "new_from_pallio"; // src && !org

    out.push({
      payerId: ref.payerId,
      state: ref.state,
      cptCode: ref.cptCode,
      attribute: ref.attribute,
      orgValue: org
        ? { coverageStatus: org.coverageStatus, ruleValue: org.ruleValue }
        : null,
      sourceValue: src
        ? {
            coverageStatus: src.coverageStatus,
            ruleValue: src.ruleValue,
            sourceQuote: src.sourceQuote ?? null,
            sourcePayerRuleId: src.sourcePayerRuleId ?? null,
          }
        : null,
      outcome,
    });
  }

  // Stable sort: diffs first (need attention), then unverified, then new,
  // then matches. Within each bucket, by payer → state → CPT.
  const order: Record<ComparisonOutcome, number> = {
    diff: 0,
    unverified: 1,
    new_from_pallio: 2,
    match: 3,
  };
  out.sort((a, b) => {
    const o = order[a.outcome] - order[b.outcome];
    if (o !== 0) return o;
    return (
      (a.payerId ?? "").localeCompare(b.payerId ?? "") ||
      a.state.localeCompare(b.state) ||
      a.cptCode.localeCompare(b.cptCode) ||
      a.attribute.localeCompare(b.attribute)
    );
  });

  return out;
}

/** Aggregate counts by outcome — drives the comparison summary banner. */
export interface ComparisonSummary {
  total: number;
  matches: number;
  diffs: number;
  unverified: number;
  newFromPallio: number;
}

export function summarizeComparison(rows: ComparisonRow[]): ComparisonSummary {
  let matches = 0;
  let diffs = 0;
  let unverified = 0;
  let newFromPallio = 0;
  for (const r of rows) {
    if (r.outcome === "match") matches++;
    else if (r.outcome === "diff") diffs++;
    else if (r.outcome === "unverified") unverified++;
    else newFromPallio++;
  }
  return {
    total: rows.length,
    matches,
    diffs,
    unverified,
    newFromPallio,
  };
}
