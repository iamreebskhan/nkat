/**
 * OrgRuleRepository — read/write access to a single org's rulebook
 * rows (`org_rulebook_row`) as an ANSWER SOURCE for rule lookups.
 *
 * This is the tenant-scoped counterpart to `payer-rule.repository.ts`,
 * which reads the global (non-RLS) `payer_rule` reference library.
 *
 * Why both exist — see `rule-lookup.service.ts` step 2:
 *   - `org_rulebook_row` is what the ORG says. It wins.
 *   - `payer_rule` is the platform's reference library (CMS seed,
 *     platform-ingested payer policy). It's the fallback, and it's
 *     shown alongside the org answer so a biller can see when their
 *     rulebook and the published rule disagree.
 *
 * Every function here goes through `withOrgContext`, so RLS confines
 * reads and writes to one tenant. Nothing in this module may write a
 * row another org can read — that invariant is the whole point of it.
 *
 * Note: unlike `payer_rule`, org rows carry no `effective_date`. They
 * represent the org's CURRENT position. They do carry `expires_at`
 * (migration 0064) because attestation-backed rows are time-boxed.
 */
import { withOrgContext } from "@/lib/db";

import {
  ATTRIBUTE_DB_MAP,
  type CoverageStatus,
  type PayerRuleAttribute,
} from "@/lib/features/billing/payer-rule.repository";

/** Mirrors the org_rulebook_row.origin CHECK (migration 0031). */
export type OrgRuleOrigin = "source" | "org_upload" | "org_override" | "analyst";

/**
 * Confidence floor for MACHINE-written org rows (origin='source').
 * Matches MIN_SQL_CONFIDENCE in rule-lookup.service.ts: an AI-synthesized
 * answer is cached at 0.4 pending analyst review, and until a human
 * confirms it, it must not answer a lookup under the org's own banner.
 */
const MIN_ORG_RULE_CONFIDENCE = 0.5;

export interface OrgRuleHit {
  rowId: string;
  attribute: PayerRuleAttribute;
  value: Record<string, unknown>;
  coverageStatus: CoverageStatus;
  confidence: number;
  origin: OrgRuleOrigin;
  sourceQuote: string | null;
  expiresAt: Date | null;
  lastEditedAt: Date | null;
  /** Set when origin='analyst' — the attestation this mirrors. */
  sourceAttestationId: string | null;
  /** The global rule this row was derived from, if any. */
  sourcePayerRuleId: string | null;
}

interface OrgRuleRow {
  row_id: string;
  attribute: string;
  rule_value: Record<string, unknown>;
  coverage_status: CoverageStatus;
  // Postgres NUMERIC arrives as a string from the pg driver.
  confidence: string;
  origin: OrgRuleOrigin;
  source_quote: string | null;
  expires_at: Date | null;
  last_edited_at: Date | null;
  source_attestation_id: string | null;
  source_payer_rule_id: string | null;
}

export interface FetchOrgRuleInput {
  orgId: string;
  payerId: string;
  state: string;
  code: string;
  attribute: PayerRuleAttribute;
  /**
   * Date of service. Org rows have no effective_date, but an
   * attestation-backed row that had already expired by the DOS must not
   * answer for it.
   */
  dos: Date;
}

/**
 * Fetch this org's own rule for (payer, state, code, attribute), or
 * null if their rulebook doesn't cover the cell.
 *
 * Ordering breaks ties when an org somehow holds more than one row for
 * a cell (possible across rulebook regenerations, since the unique
 * index is per-rulebook): an explicit human decision outranks a
 * mirrored one, then most-recently-edited wins.
 */
export async function fetchOrgRule(
  input: FetchOrgRuleInput,
): Promise<OrgRuleHit | null> {
  const dbAttribute = ATTRIBUTE_DB_MAP[input.attribute] ?? input.attribute;

  const rows = await withOrgContext(input.orgId, (tx) =>
    tx.$queryRaw<OrgRuleRow[]>`
      SELECT
        r.id                    AS row_id,
        r.attribute             AS attribute,
        r.rule_value            AS rule_value,
        r.coverage_status       AS coverage_status,
        r.confidence::text      AS confidence,
        r.origin                AS origin,
        r.source_quote          AS source_quote,
        r.expires_at            AS expires_at,
        r.last_edited_at        AS last_edited_at,
        r.source_attestation_id AS source_attestation_id,
        r.source_payer_rule_id  AS source_payer_rule_id
      FROM org_rulebook_row r
      WHERE r.org_id    = ${input.orgId}::uuid
        AND r.payer_id  = ${input.payerId}::uuid
        AND r.state     = ${input.state}
        AND r.cpt_code  = ${input.code}
        AND r.attribute = ${dbAttribute}
        AND (r.expires_at IS NULL OR r.expires_at > ${input.dos})
        -- Human decisions (analyst call, manual override, uploaded
        -- rulebook) always answer. Machine-written rows (origin
        -- 'source' — the AI-synthesized cache) must clear the same
        -- confidence floor the global library does, so an unverified
        -- 0.4 guess is never presented to a biller as "your rulebook".
        AND (r.origin <> 'source' OR r.confidence >= ${MIN_ORG_RULE_CONFIDENCE})
      ORDER BY
        (r.origin = 'org_override') DESC,
        (r.origin = 'analyst')      DESC,
        (r.origin = 'org_upload')   DESC,
        COALESCE(r.last_edited_at, r.updated_at) DESC
      LIMIT 1
    `,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    rowId: row.row_id,
    // Map the DB long-form name back to the API short name so callers
    // can compare against the requested attribute without re-mapping.
    attribute: input.attribute,
    value: row.rule_value ?? {},
    coverageStatus: row.coverage_status,
    confidence: parseFloat(row.confidence),
    origin: row.origin,
    sourceQuote: row.source_quote,
    expiresAt: row.expires_at,
    lastEditedAt: row.last_edited_at,
    sourceAttestationId: row.source_attestation_id,
    sourcePayerRuleId: row.source_payer_rule_id,
  };
}

/**
 * Get the org's rulebook container, creating an empty one if this is
 * the first row they've ever recorded. `org_rulebook_row.rulebook_id`
 * is NOT NULL, so callers that write a single cell (an attestation, an
 * AI-synthesized answer) still need a rulebook to hang it off — they
 * shouldn't have to run the full Path-A generation first.
 *
 * The ON CONFLICT branch deliberately does NOT bump `current_version`:
 * adding one cell is not a regeneration.
 */
async function getOrCreateRulebookId(
  tx: Parameters<Parameters<typeof withOrgContext<unknown>>[1]>[0],
  orgId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO org_rulebook (org_id, origin, current_version)
    VALUES (${orgId}::uuid, 'generated', 1)
    ON CONFLICT (org_id) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return rows[0]!.id;
}

export interface UpsertOrgRuleInput {
  orgId: string;
  payerId: string;
  state: string;
  code: string;
  /** API-side short attribute name; mapped to the DB long form here. */
  attribute: PayerRuleAttribute | string;
  coverageStatus: CoverageStatus;
  ruleValue: Record<string, unknown>;
  confidence: number;
  origin: OrgRuleOrigin;
  sourceQuote: string | null;
  expiresAt?: Date | string | null;
  sourceAttestationId?: string | null;
  sourcePayerRuleId?: string | null;
  byUserId?: string | null;
  /**
   * When true, an existing `origin='org_override'` row is left alone —
   * a machine-generated value must never silently overwrite a human's
   * deliberate override. Attestations pass false: an analyst confirming
   * a rule by phone IS the deliberate human decision.
   */
  preserveOverride: boolean;
}

/**
 * Write one cell into this org's rulebook. Tenant-scoped: the row is
 * visible to this org and no other.
 */
export async function upsertOrgRule(
  input: UpsertOrgRuleInput,
): Promise<{ rowId: string; skipped: boolean }> {
  const dbAttribute =
    ATTRIBUTE_DB_MAP[input.attribute as PayerRuleAttribute] ?? input.attribute;
  const expiresAt =
    input.expiresAt instanceof Date
      ? input.expiresAt.toISOString()
      : (input.expiresAt ?? null);

  return withOrgContext(input.orgId, async (tx) => {
    const rulebookId = await getOrCreateRulebookId(tx, input.orgId);

    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO org_rulebook_row (
        org_id, rulebook_id, payer_id, state, cpt_code, attribute,
        rule_value, coverage_status, origin, confidence,
        source_payer_rule_id, source_quote, source_attestation_id,
        expires_at, last_edited_by_user_id, last_edited_at
      ) VALUES (
        ${input.orgId}::uuid, ${rulebookId}::uuid, ${input.payerId}::uuid,
        ${input.state}, ${input.code}, ${dbAttribute},
        ${JSON.stringify(input.ruleValue)}::jsonb, ${input.coverageStatus},
        ${input.origin}, ${input.confidence},
        ${input.sourcePayerRuleId ?? null}::uuid, ${input.sourceQuote},
        ${input.sourceAttestationId ?? null}::uuid,
        ${expiresAt}::timestamptz, ${input.byUserId ?? null}::uuid, now()
      )
      ON CONFLICT (rulebook_id, payer_id, state, cpt_code, attribute)
      DO UPDATE SET
        rule_value            = EXCLUDED.rule_value,
        coverage_status       = EXCLUDED.coverage_status,
        origin                = EXCLUDED.origin,
        confidence            = EXCLUDED.confidence,
        source_payer_rule_id  = EXCLUDED.source_payer_rule_id,
        source_quote          = EXCLUDED.source_quote,
        source_attestation_id = EXCLUDED.source_attestation_id,
        expires_at            = EXCLUDED.expires_at,
        last_edited_by_user_id = EXCLUDED.last_edited_by_user_id,
        last_edited_at        = now(),
        updated_at            = now()
      WHERE NOT ${input.preserveOverride}::boolean
         OR org_rulebook_row.origin <> 'org_override'
      RETURNING id
    `;

    // Zero rows back means the ON CONFLICT ... WHERE guard suppressed
    // the update: the org has an explicit override we must not touch.
    if (rows.length === 0) {
      const existing = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM org_rulebook_row
         WHERE rulebook_id = ${rulebookId}::uuid
           AND payer_id    = ${input.payerId}::uuid
           AND state       = ${input.state}
           AND cpt_code    = ${input.code}
           AND attribute   = ${dbAttribute}
         LIMIT 1
      `;
      return { rowId: existing[0]?.id ?? "", skipped: true };
    }

    return { rowId: rows[0]!.id, skipped: false };
  });
}
