/**
 * Rulebook service — Path A generation, Path B upload, persist, finalize.
 *
 * Path A (§9.3): query the global `payer_rule` library for every
 * (active payer × active state × active CPT × attribute) tuple the
 * org configured in the wizard. Each hit becomes an `org_rulebook_row`
 * with `origin='source'` and the source citation. Cells with no
 * matching rule still appear, marked `coverage_status='unknown'` so
 * the org admin sees the gap.
 *
 * Path B (§9.4): the org uploads a doc; the extractor parses it into
 * proposed rows; we run `compareRulebooks` from `rulebook-pure` to
 * produce the side-by-side view. The org admin resolves each row,
 * then we persist the merged set.
 */
import { withOrgContext } from "@/lib/db";
import { compareRulebooks } from "./rulebook-pure";
import type {
  ComparisonRow,
  CoverageStatus,
  RulebookAttribute,
  RulebookOrigin,
  RulebookRowView,
  RulebookView,
} from "./rulebook.types";

interface RulebookRow {
  id: string;
  org_id: string;
  current_version: number;
  origin: RulebookOrigin;
  source_state_codes: string[];
  source_payer_ids: string[];
  source_cpt_codes: string[];
  finalized_at: Date;
  finalized_by_user_id: string | null;
  notes: string | null;
}

interface RowRow {
  id: string;
  payer_id: string | null;
  state: string;
  cpt_code: string;
  attribute: RulebookAttribute;
  rule_value: Record<string, unknown>;
  coverage_status: CoverageStatus;
  origin: "source" | "org_upload" | "org_override" | "analyst";
  confidence: string | number;
  source_payer_rule_id: string | null;
  source_quote: string | null;
  last_edited_by_user_id: string | null;
  last_edited_at: Date | null;
}

function rowToView(r: RowRow): RulebookRowView {
  return {
    id: r.id,
    payerId: r.payer_id,
    state: r.state,
    cptCode: r.cpt_code,
    attribute: r.attribute,
    ruleValue: r.rule_value,
    coverageStatus: r.coverage_status,
    origin: r.origin,
    confidence: typeof r.confidence === "string" ? parseFloat(r.confidence) : r.confidence,
    sourcePayerRuleId: r.source_payer_rule_id,
    sourceQuote: r.source_quote,
    lastEditedByUserId: r.last_edited_by_user_id,
    lastEditedAt: r.last_edited_at?.toISOString() ?? null,
  };
}

interface SourceQueryRow {
  payer_id: string;
  state: string;
  code: string;
  attribute: RulebookAttribute;
  rule_value: Record<string, unknown>;
  coverage_status: CoverageStatus;
  confidence: string | number;
  rule_id: string;
  source_quote: string | null;
}

/**
 * Path A: build a fresh rulebook from the org's onboarding inputs.
 *
 * Wholesale-replace strategy: drop the existing rulebook (if any) and
 * insert a new one + its rows. Idempotent — calling twice with the
 * same inputs produces the same rows. The version snapshot table
 * keeps history.
 */
export async function generateRulebook(args: {
  orgId: string;
  byUserId: string;
  states: string[];
  payerIds: string[];
  cptCodes: string[];
}): Promise<RulebookView> {
  const { orgId, byUserId, states, payerIds, cptCodes } = args;
  return withOrgContext(orgId, async (tx) => {
    // Pull every matching source rule in one query.
    const sourceRows: SourceQueryRow[] = states.length === 0 || payerIds.length === 0 || cptCodes.length === 0
      ? []
      : await tx.$queryRaw<SourceQueryRow[]>`
        SELECT
          pr.payer_id, pr.state, pr.code, pr.attribute,
          pr.value AS rule_value,
          pr.coverage_status,
          pr.confidence::text AS confidence,
          pr.id AS rule_id,
          pr.source_quote
        FROM payer_rule pr
        WHERE pr.payer_id = ANY(${payerIds}::uuid[])
          AND pr.state    = ANY(${states}::text[])
          AND pr.code     = ANY(${cptCodes}::text[])
          AND pr.expiration_date IS NULL
      `;

    // Bump existing rulebook version (or insert new).
    const rb = await tx.$queryRaw<RulebookRow[]>`
      INSERT INTO org_rulebook (
        org_id, origin, source_state_codes, source_payer_ids,
        source_cpt_codes, finalized_by_user_id, current_version
      ) VALUES (
        ${orgId}::uuid, 'generated',
        ${states}::text[], ${payerIds}::uuid[], ${cptCodes}::text[],
        ${byUserId}::uuid, 1
      )
      ON CONFLICT (org_id) DO UPDATE SET
        origin = 'generated',
        source_state_codes = EXCLUDED.source_state_codes,
        source_payer_ids = EXCLUDED.source_payer_ids,
        source_cpt_codes = EXCLUDED.source_cpt_codes,
        current_version = org_rulebook.current_version + 1,
        finalized_at = now(),
        finalized_by_user_id = EXCLUDED.finalized_by_user_id,
        updated_at = now()
      RETURNING *
    `;
    const rulebook = rb[0]!;

    // Drop existing rows; we re-insert from the source.
    await tx.$executeRaw`
      DELETE FROM org_rulebook_row WHERE rulebook_id = ${rulebook.id}::uuid
    `;

    // Build the cartesian: every (payer, state, cpt) the org cares
    // about. Each combo yields one row per attribute we have a rule
    // for; if no rules exist for a combo, we emit a single 'unknown'
    // placeholder so the gap is visible.
    const sourceByKey = new Map<string, SourceQueryRow>();
    for (const r of sourceRows) {
      const key = `${r.payer_id}|${r.state}|${r.code}|${r.attribute}`;
      sourceByKey.set(key, r);
    }

    const inserts: Array<{
      payer_id: string;
      state: string;
      cpt_code: string;
      attribute: RulebookAttribute;
      rule_value: string;
      coverage_status: CoverageStatus;
      origin: "source";
      confidence: number;
      source_payer_rule_id: string | null;
      source_quote: string | null;
    }> = [];

    for (const payerId of payerIds) {
      for (const state of states) {
        for (const cpt of cptCodes) {
          // Always emit at least the 'covered' attribute. If the source
          // has multiple attributes for this combo, emit them all.
          const attrs: RulebookAttribute[] = ["covered"];
          // Discover any extra attributes already in source for this combo.
          for (const r of sourceRows) {
            if (r.payer_id === payerId && r.state === state && r.code === cpt && !attrs.includes(r.attribute)) {
              attrs.push(r.attribute);
            }
          }
          for (const attr of attrs) {
            const hit = sourceByKey.get(`${payerId}|${state}|${cpt}|${attr}`);
            inserts.push({
              payer_id: payerId,
              state,
              cpt_code: cpt,
              attribute: attr,
              rule_value: JSON.stringify(hit?.rule_value ?? {}),
              coverage_status: hit?.coverage_status ?? "unknown",
              origin: "source",
              confidence: hit
                ? typeof hit.confidence === "string"
                  ? parseFloat(hit.confidence)
                  : hit.confidence
                : 0,
              source_payer_rule_id: hit?.rule_id ?? null,
              source_quote: hit?.source_quote ?? null,
            });
          }
        }
      }
    }

    if (inserts.length > 0) {
      // Bulk-insert via UNNEST. The arrays are positional — each index
      // across all 9 arrays describes one row.
      await tx.$executeRaw`
        INSERT INTO org_rulebook_row (
          org_id, rulebook_id, payer_id, state, cpt_code, attribute,
          rule_value, coverage_status, origin, confidence,
          source_payer_rule_id, source_quote
        )
        SELECT
          ${orgId}::uuid, ${rulebook.id}::uuid,
          payer_id::uuid, state, cpt_code, attribute,
          rule_value::jsonb, coverage_status, origin, confidence,
          -- source_payer_rule_id is nullable. UNNEST gives us empty
          -- strings for missing values (cells where the rulebook
          -- generator had to emit 'unknown' with no PayerRule source);
          -- cast '' to NULL before the uuid cast.
          NULLIF(source_payer_rule_id, '')::uuid, source_quote
        FROM UNNEST(
          ${inserts.map((i) => i.payer_id)}::text[],
          ${inserts.map((i) => i.state)}::text[],
          ${inserts.map((i) => i.cpt_code)}::text[],
          ${inserts.map((i) => i.attribute)}::text[],
          ${inserts.map((i) => i.rule_value)}::text[],
          ${inserts.map((i) => i.coverage_status)}::text[],
          ${inserts.map((i) => i.origin)}::text[],
          ${inserts.map((i) => i.confidence)}::float8[],
          ${inserts.map((i) => i.source_payer_rule_id ?? "")}::text[],
          ${inserts.map((i) => i.source_quote ?? "")}::text[]
        ) AS t(
          payer_id, state, cpt_code, attribute, rule_value,
          coverage_status, origin, confidence,
          source_payer_rule_id, source_quote
        )
      `;
    }

    return readRulebook({ orgId, tx });
  });
}

/** Read the org's current rulebook + all rows. */
export async function getRulebook(args: {
  orgId: string;
}): Promise<RulebookView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    return readRulebook({ orgId: args.orgId, tx });
  });
}

async function readRulebook(args: {
  orgId: string;
  tx: Parameters<Parameters<typeof withOrgContext<RulebookView>>[1]>[0];
}): Promise<RulebookView> {
  const { orgId, tx } = args;
  const rb = await tx.$queryRaw<RulebookRow[]>`
    SELECT * FROM org_rulebook WHERE org_id = ${orgId}::uuid LIMIT 1
  `;
  if (!rb[0]) {
    return {
      id: "",
      orgId,
      currentVersion: 0,
      origin: "generated",
      sourceStateCodes: [],
      sourcePayerIds: [],
      sourceCptCodes: [],
      finalizedAt: new Date().toISOString(),
      finalizedByUserId: null,
      notes: null,
      rows: [],
    };
  }

  const rows = await tx.$queryRaw<RowRow[]>`
    SELECT id, payer_id, state, cpt_code, attribute, rule_value,
           coverage_status, origin, confidence::text AS confidence,
           source_payer_rule_id, source_quote,
           last_edited_by_user_id, last_edited_at
    FROM org_rulebook_row
    WHERE rulebook_id = ${rb[0].id}::uuid
    ORDER BY state, payer_id, cpt_code, attribute
  `;

  return {
    id: rb[0].id,
    orgId: rb[0].org_id,
    currentVersion: rb[0].current_version,
    origin: rb[0].origin,
    sourceStateCodes: rb[0].source_state_codes,
    sourcePayerIds: rb[0].source_payer_ids,
    sourceCptCodes: rb[0].source_cpt_codes,
    finalizedAt: rb[0].finalized_at.toISOString(),
    finalizedByUserId: rb[0].finalized_by_user_id,
    notes: rb[0].notes,
    rows: rows.map(rowToView),
  };
}

/**
 * Apply org-admin edits to a rulebook. Each edit overwrites the cell's
 * `coverage_status` + `rule_value` and flips origin → 'org_override'.
 * Records the user + timestamp for audit.
 */
export async function applyEdits(args: {
  orgId: string;
  edits: { rowId: string; ruleValue: Record<string, unknown>; coverageStatus: CoverageStatus }[];
  byUserId: string;
}): Promise<{ updated: number }> {
  let n = 0;
  await withOrgContext(args.orgId, async (tx) => {
    for (const e of args.edits) {
      await tx.$executeRaw`
        UPDATE org_rulebook_row SET
          rule_value = ${JSON.stringify(e.ruleValue)}::jsonb,
          coverage_status = ${e.coverageStatus},
          origin = 'org_override',
          last_edited_by_user_id = ${args.byUserId}::uuid,
          last_edited_at = now(),
          updated_at = now()
        WHERE id = ${e.rowId}::uuid
      `;
      n++;
    }
  });
  return { updated: n };
}

/**
 * Build the §9.4 side-by-side comparison: the org's uploaded rows vs
 * the source library. Pure logic delegates to `compareRulebooks`.
 */
export async function buildComparison(args: {
  orgId: string;
  uploadId: string;
}): Promise<ComparisonRow[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const upload = await tx.$queryRaw<{ parsed_rows: unknown }[]>`
      SELECT parsed_rows FROM rulebook_upload WHERE id = ${args.uploadId}::uuid LIMIT 1
    `;
    if (!upload[0]) throw new Error("buildComparison: upload not found");
    const orgRows = (upload[0].parsed_rows as unknown[]) as Array<{
      payerId: string | null;
      state: string;
      cptCode: string;
      attribute: RulebookAttribute;
      coverageStatus: CoverageStatus;
      ruleValue: Record<string, unknown>;
    }>;

    if (orgRows.length === 0) return [];

    const payerIds = Array.from(
      new Set(orgRows.map((r) => r.payerId).filter((v): v is string => !!v)),
    );
    const states = Array.from(new Set(orgRows.map((r) => r.state)));
    const cpts = Array.from(new Set(orgRows.map((r) => r.cptCode)));

    const sourceRows: SourceQueryRow[] = await tx.$queryRaw<SourceQueryRow[]>`
      SELECT
        pr.payer_id, pr.state, pr.code, pr.attribute,
        pr.value AS rule_value,
        pr.coverage_status,
        pr.confidence::text AS confidence,
        pr.id AS rule_id,
        pr.source_quote
      FROM payer_rule pr
      WHERE pr.payer_id = ANY(${payerIds}::uuid[])
        AND pr.state    = ANY(${states}::text[])
        AND pr.code     = ANY(${cpts}::text[])
        AND pr.expiration_date IS NULL
    `;

    return compareRulebooks({
      orgRows,
      sourceRows: sourceRows.map((r) => ({
        payerId: r.payer_id,
        state: r.state,
        cptCode: r.code,
        attribute: r.attribute,
        coverageStatus: r.coverage_status,
        ruleValue: r.rule_value,
        sourceQuote: r.source_quote,
        sourcePayerRuleId: r.rule_id,
      })),
    });
  });
}
