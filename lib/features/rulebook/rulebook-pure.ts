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
  RowOrigin,
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

type OrgRow = PartialRow;

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

/**
 * Where a global payer_rule came from, read from its created_by marker
 * (audit R21).
 *
 * 'extract:<batch>' is a rule extracted from a published payer or CMS
 * document: the same evidence as a crawl, and most of the library (5,563 of
 * 7,252 rules locally). Both derivations missed it. The Rulebook badged those
 * rules 'analyst (manual)', and the picker's view compared created_by with
 * 'crawler' and 'cms' exactly, so every picker row read 'Unsourced'.
 */
export type RuleSourceKind = "crawler" | "analyst" | "ai" | "manual" | "unknown";
export type RulebookSourceKind = RuleSourceKind | "org";

export function payerRuleSourceKind(createdBy: string | null | undefined): RuleSourceKind {
  const c = (createdBy ?? "").trim();
  if (!c) return "unknown";
  if (c === "ai") return "ai";
  if (c.startsWith("extract:") || c === "crawler" || c.startsWith("crawler:") || c === "cms") {
    return "crawler";
  }
  if (c.startsWith("analyst:") || c.includes("@")) return "analyst";
  return "manual";
}

/**
 * A Rulebook row's badge: the org's own provenance trumps the linked rule's.
 *
 * `row` identifies the one machine writer that links no library rule: a rule
 * lookup that synthesizes a cited answer caches it as an origin 'source' row
 * with a confidence (0.4) but no source_payer_rule_id. Without it those rows
 * read "no linked source", like any other unlinked row, and never "AI draft".
 * Generation placeholders link no rule either, but carry confidence 0.
 */
export function sourceKindFor(
  origin: RowOrigin,
  createdBy: string | null | undefined,
  row?: { sourcePayerRuleId: string | null; confidence: number },
): RulebookSourceKind {
  if (origin === "org_upload" || origin === "org_override") return "org";
  if (origin === "analyst") return "analyst";
  if (row && !row.sourcePayerRuleId && row.confidence > 0) return "ai";
  return payerRuleSourceKind(createdBy);
}

/** What a Rulebook confidence number means (audit R21). */
export interface ConfidenceInput {
  origin: RowOrigin;
  confidence: number;
  sourceKind: RulebookSourceKind;
  sourcePayerRuleId: string | null;
  expiresAt: string | null;
}

export type ConfidenceTone = "strong" | "weak" | "expired" | "org" | "none";

export interface ConfidenceLabel {
  label: string;
  tone: ConfidenceTone;
}

/**
 * A placeholder. Generation emits one for every attribute Pallio holds no
 * rule on, at confidence 0 with no linked rule, and "0%" read as "assessed
 * and judged worthless" when the truth is "nothing on file yet".
 */
export function isPlaceholderRow(
  r: Pick<ConfidenceInput, "origin" | "confidence" | "sourcePayerRuleId">,
): boolean {
  return r.origin === "source" && !r.sourcePayerRuleId && !(r.confidence > 0);
}

/**
 * Below this a machine-written row never answers a billing lookup: the same
 * floor as MIN_ORG_RULE_CONFIDENCE in org-rule.repository.ts.
 */
const LOOKUP_FLOOR = 0.5;

export function confidenceDisplay(r: ConfidenceInput, now: Date = new Date()): ConfidenceLabel {
  // The org's own decisions are not scored against a source. They are the
  // org's, and they always answer.
  if (r.origin === "org_upload" || r.origin === "org_override") return { label: "Your org", tone: "org" };
  // Lookups stop honouring an attestation at expires_at; say so here too.
  if (r.origin === "analyst" && r.expiresAt && Date.parse(r.expiresAt) <= now.getTime()) {
    return { label: "Attestation expired", tone: "expired" };
  }
  if (isPlaceholderRow(r)) return { label: "No rule on file", tone: "none" };
  const pct = `${Math.round(r.confidence * 100)}%`;
  if (r.origin === "source" && r.confidence < LOOKUP_FLOOR) {
    return {
      label: r.sourceKind === "ai" ? "AI draft · not used for billing" : `${pct} · not used for billing`,
      tone: "weak",
    };
  }
  return { label: pct, tone: "strong" };
}

/**
 * The collapsed row's headline. It printed the MAXIMUM across a code's
 * attributes, which hid the placeholders entirely: a code with one strong
 * rule and two gaps read as strong. This prints the WEAKEST attribute on
 * file and says how many have nothing on file. `weakest` indexes the row it
 * describes, so the screen can badge that row's source.
 */
export function summarizeConfidence(
  rows: readonly ConfidenceInput[],
  now: Date = new Date(),
): ConfidenceLabel & { weakest: number | null } {
  const shown = rows.map((r, i) => ({ r, i, d: confidenceDisplay(r, now) }));
  const onFile = shown.filter((x) => x.d.tone !== "none");
  if (onFile.length === 0) return { label: "No rule on file", tone: "none", weakest: null };
  const rank: Record<ConfidenceTone, number> = { expired: 0, weak: 1, strong: 2, org: 3, none: 4 };
  const weakest = onFile.reduce((a, b) => {
    const d = rank[b.d.tone] - rank[a.d.tone];
    if (d !== 0) return d < 0 ? b : a;
    return b.r.confidence < a.r.confidence ? b : a;
  });
  const gaps = rows.length - onFile.length;
  return {
    label: weakest.d.label + (gaps > 0 ? ` · ${gaps} of ${rows.length} not on file` : ""),
    tone: weakest.d.tone,
    weakest: weakest.i,
  };
}
