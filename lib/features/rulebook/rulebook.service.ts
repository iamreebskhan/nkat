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
import type { Prisma } from "@prisma/client";

import { NotFoundError } from "@/lib/api";
import { withBreakglass, withOrgContext } from "@/lib/db";
import { hasAmaLicense } from "@/lib/features/billing/code.service";
import { ATTRIBUTE_DB_MAP, type PayerRuleAttribute } from "@/lib/features/billing/payer-rule.repository";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import { compareRulebooks, ownEditFields, sourceKindFor } from "./rulebook-pure";
import type {
  ComparisonRow,
  CoverageStatus,
  MergeDecision,
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
  payer_name: string | null;
  payer_type: string | null;
  state: string;
  cpt_code: string;
  code_system: string | null;
  cpt_description: string | null;
  attribute: RulebookAttribute;
  rule_value: Record<string, unknown>;
  coverage_status: CoverageStatus;
  origin: "source" | "org_upload" | "org_override" | "analyst";
  confidence: string | number;
  source_payer_rule_id: string | null;
  source_quote: string | null;
  source_created_by: string | null;
  last_edited_by_user_id: string | null;
  last_edited_at: Date | null;
  /** When an analyst attestation stops answering lookups; NULL = never. */
  expires_at: Date | null;
}

function rowToView(r: RowRow): RulebookRowView {
  return {
    id: r.id,
    payerId: r.payer_id,
    payerName: r.payer_name,
    payerType: r.payer_type,
    state: r.state,
    cptCode: r.cpt_code,
    codeSystem: r.code_system,
    cptDescription: r.cpt_description,
    attribute: r.attribute,
    ruleValue: r.rule_value,
    coverageStatus: r.coverage_status,
    origin: r.origin,
    confidence: typeof r.confidence === "string" ? parseFloat(r.confidence) : r.confidence,
    sourcePayerRuleId: r.source_payer_rule_id,
    sourceQuote: r.source_quote,
    sourceCreatedBy: r.source_created_by,
    // rulebook-pure's sourceKindFor: it knows 'extract:*' is a published
    // document, which the old derivation badged 'analyst (manual)' (R21).
    sourceKind: sourceKindFor(r.origin, r.source_created_by, {
      sourcePayerRuleId: r.source_payer_rule_id,
      confidence: typeof r.confidence === "string" ? parseFloat(r.confidence) : r.confidence,
    }),
    lastEditedByUserId: r.last_edited_by_user_id,
    lastEditedAt: r.last_edited_at?.toISOString() ?? null,
    expiresAt: r.expires_at?.toISOString() ?? null,
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
 * The library rule that answers each (payer, state, code, attribute) key
 * today where the practice is: the latest effective date in force, then id,
 * as close-rule-timelines.sql picks its anchor and
 * app.refresh_rulebook_mirrors() (migration 0130) picks a row's rule, so a
 * fresh rulebook, a refreshed one and an upload's comparison hold the same
 * rule. "expiration_date IS NULL" took any open-ended row, a rule not yet in
 * force among them, and where a key had several the last one read won.
 */
async function libraryRulesToday(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  orgId: string,
  keys: { payerIds: string[]; states: string[]; codes: string[] },
): Promise<SourceQueryRow[]> {
  if (keys.payerIds.length === 0 || keys.states.length === 0 || keys.codes.length === 0) return [];
  const today = orgToday(await readOrgTimeZone(tx, orgId));
  return tx.$queryRaw<SourceQueryRow[]>`
    SELECT DISTINCT ON (pr.payer_id, pr.state, pr.code, pr.attribute)
      pr.payer_id, pr.state, pr.code, pr.attribute,
      pr.value AS rule_value,
      pr.coverage_status,
      pr.confidence::text AS confidence,
      pr.id AS rule_id,
      pr.source_quote
    FROM payer_rule pr
    WHERE pr.payer_id = ANY(${keys.payerIds}::uuid[])
      AND pr.state    = ANY(${keys.states}::text[])
      AND pr.code     = ANY(${keys.codes}::text[])
      AND pr.effective_date <= ${today}::date
      AND (pr.expiration_date IS NULL OR pr.expiration_date > ${today}::date)
    ORDER BY pr.payer_id, pr.state, pr.code, pr.attribute,
             pr.effective_date DESC, pr.id DESC
  `;
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
    const sourceRows = await libraryRulesToday(tx, orgId, { payerIds, states, codes: cptCodes });

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

  // Join payer for human-readable header (name + type), and `code`
  // for the CPT/HCPCS short descriptor. CPT descriptors are AMA-
  // licensed: if AMA_LICENSE_TOKEN isn't set we swap the text for a
  // placeholder server-side; HCPCS (CMS public domain) flows freely.
  const amaLicensed = hasAmaLicense();
  const rows = await tx.$queryRaw<RowRow[]>`
    SELECT
      r.id, r.payer_id,
      p.name        AS payer_name,
      p.payer_type  AS payer_type,
      r.state, r.cpt_code,
      c.code_system AS code_system,
      CASE
        WHEN c.code IS NULL THEN NULL
        WHEN c.code_system = 'CPT' AND NOT ${amaLicensed} THEN '[AMA license required]'
        ELSE c.short_descriptor
      END AS cpt_description,
      r.attribute, r.rule_value,
      r.coverage_status, r.origin,
      r.confidence::text AS confidence,
      r.source_payer_rule_id, r.source_quote,
      pr.created_by AS source_created_by,
      r.last_edited_by_user_id, r.last_edited_at, r.expires_at
    FROM org_rulebook_row r
    LEFT JOIN payer p ON p.id = r.payer_id
    LEFT JOIN code  c ON c.code = r.cpt_code
    LEFT JOIN payer_rule pr ON pr.id = r.source_payer_rule_id
    WHERE r.rulebook_id = ${rb[0].id}::uuid
    ORDER BY r.state, p.name NULLS LAST, r.cpt_code, r.attribute
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
 *
 * An edit that changes the coverage also drops what the row said for its
 * old coverage: the value keeps only the editor's own fields
 * (rulebook-pure ownEditFields) and the quote goes with it. It is compared
 * with the row as stored, so an edit that leaves the coverage as it was (a
 * note, or a coverage changed and changed back before saving) keeps the
 * value as sent.
 */
export async function applyEdits(args: {
  orgId: string;
  edits: { rowId: string; ruleValue: Record<string, unknown>; coverageStatus: CoverageStatus }[];
  byUserId: string;
}): Promise<{ updated: number }> {
  let n = 0;
  await withOrgContext(args.orgId, async (tx) => {
    for (const e of args.edits) {
      // SET reads the row as it was: coverage_status in the CASEs is the stored one.
      await tx.$executeRaw`
        UPDATE org_rulebook_row SET
          rule_value = CASE WHEN coverage_status = ${e.coverageStatus}
                            THEN ${JSON.stringify(e.ruleValue)}::jsonb
                            ELSE ${JSON.stringify(ownEditFields(e.ruleValue))}::jsonb
                       END,
          source_quote = CASE WHEN coverage_status = ${e.coverageStatus} THEN source_quote END,
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
 * Auto-refresh every org's rulebook_row that points at the same
 * (payer, state, code, attribute) key as a freshly-written
 * payer_rule. CROSS-ORG by design — it writes rows that 100+ other
 * tenants read — so it uses breakglass to bypass tenant RLS.
 *
 * ⚠️ PLATFORM INGESTION ONLY. The only legitimate caller is
 * `document-ingestion.service.ts`, where a platform admin has ingested
 * a payer/CMS document into the global library and every org's mirror
 * of that library should follow. It is NOT for org-triggered actions.
 *
 * It used to be called from two org-triggered paths — analyst
 * attestations and the AI-synthesized persist in
 * `app/api/billing/lookup/route.ts`. Both meant one tenant's action
 * rewrote every other tenant's rulebook, and the attestation path also
 * expired the underlying global payer_rule for everyone. Those now
 * write to the acting org's own rulebook via
 * `org-rule.repository.ts#upsertOrgRule`. Do not reintroduce a call
 * from an org-scoped code path; if you need one, you want upsertOrgRule.
 *
 * Only the machine's own rows (origin='source') follow. A person's edit
 * ('org_override'), uploaded rulebook ('org_upload') or payer call
 * ('analyst') is the org's position and stays as they left it; an
 * uploaded row used to be rewritten here and relabelled 'source'.
 *
 * Returns the number of org rulebook rows refreshed across all orgs.
 */
export async function propagateGlobalRuleToAllOrgRulebooks(args: {
  ruleId: string;
  payerId: string;
  state: string;
  /** DB-enum attribute name (already mapped via ATTRIBUTE_DB_MAP). */
  dbAttribute: string;
  cptCode: string;
  coverageStatus: CoverageStatus;
  ruleValue: Record<string, unknown>;
  confidence: number;
  sourceQuote: string | null;
}): Promise<number> {
  return withBreakglass(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE org_rulebook_row SET
        source_payer_rule_id = ${args.ruleId}::uuid,
        coverage_status = ${args.coverageStatus},
        rule_value = ${JSON.stringify(args.ruleValue)}::jsonb,
        source_quote = ${args.sourceQuote},
        confidence = ${args.confidence},
        updated_at = now()
       WHERE payer_id = ${args.payerId}::uuid
         AND state = ${args.state}
         AND cpt_code = ${args.cptCode}
         AND attribute = ${args.dbAttribute}
         -- Never clobber a tenant's own position: an explicit override,
         -- an uploaded rulebook or an analyst's payer call outranks a
         -- library refresh.
         AND origin = 'source'
    `;
    return Number(updated);
  }, "propagate global payer_rule change to org rulebook mirrors");
}

/** A cell's attribute under the library's name, which the rulebook stores and the lookup reads. */
function libraryAttribute(attribute: string): string {
  return ATTRIBUTE_DB_MAP[attribute as PayerRuleAttribute] ?? attribute;
}

function cellKey(c: { payerId: string | null; state: string; cptCode: string; attribute: string }): string {
  return `${c.payerId ?? ""}|${c.state}|${c.cptCode}|${c.attribute}`;
}

/** What every uploaded row has carried: the column's default. */
const UPLOADED_ROW_CONFIDENCE = 0.5;

/**
 * The cells, among `cells`, that someone at the practice already decided in
 * its rulebook: edited by hand, or confirmed with the payer by an analyst.
 * A merge leaves those as they are. An org has one rulebook (UNIQUE org_id).
 */
async function heldCells(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  orgId: string,
  cells: { payerId: string | null; state: string; cptCode: string; attribute: string }[],
): Promise<Map<string, "org_override" | "analyst">> {
  if (cells.length === 0) return new Map();
  const keys = cells.map((c) => ({ payer_id: c.payerId, state: c.state, cpt_code: c.cptCode, attribute: c.attribute }));
  const rows = await tx.$queryRaw<
    { payer_id: string | null; state: string; cpt_code: string; attribute: string; origin: "org_override" | "analyst" }[]
  >`
    SELECT r.payer_id, r.state, r.cpt_code, r.attribute, r.origin
      FROM org_rulebook_row r
      JOIN jsonb_to_recordset(${JSON.stringify(keys)}::jsonb)
           AS k(payer_id uuid, state text, cpt_code text, attribute text)
        ON r.payer_id IS NOT DISTINCT FROM k.payer_id
       AND r.state = k.state AND r.cpt_code = k.cpt_code AND r.attribute = k.attribute
     WHERE r.org_id = ${orgId}::uuid
       AND r.origin IN ('org_override', 'analyst')
  `;
  return new Map(
    rows.map((r) => [cellKey({ payerId: r.payer_id, state: r.state, cptCode: r.cpt_code, attribute: r.attribute }), r.origin]),
  );
}

/**
 * Path B merge (§9.4.3): write the org's per-row decisions from the
 * comparison view into its rulebook, then mark the upload 'merged'.
 *
 * Each decision says which side the practice took for one cell. "upload"
 * keeps the practice's own value ('org_upload'). "library" keeps Pallio's
 * rule as a library copy (origin 'source') of the rule in force today, as
 * generation writes one, so it follows the library from then on
 * (app.refresh_rulebook_mirrors(), migration 0130) and the lookup answers
 * the cell from the library for the date of service. A pick of Pallio's rule
 * was stored as the practice's own: frozen as the library read that day, and
 * answering every date of service with it.
 *
 * A decision replaces the cell's library copy or an earlier upload. A cell
 * someone at the practice edited by hand, or an analyst confirmed with the
 * payer, is left as it is and counted in `kept`; the comparison marks those
 * before anyone applies (keptAs). Its default pick is Pallio's rule wherever
 * the library has one, so replacing them would have overwritten a person's
 * decision nobody was shown. Decisions used to be inserted blind, and a cell
 * the rulebook already held (every cell, once a rulebook was generated) broke
 * the unique index and rolled the whole merge back.
 */
export async function mergeUploadedRulebook(args: {
  orgId: string;
  uploadId: string;
  byUserId: string;
  decisions: MergeDecision[];
}): Promise<{ merged: number; fromLibrary: number; kept: number }> {
  // One decision per cell, under the library's attribute names. A file says
  // 'prior_auth'; stored under that name a row never answered a lookup,
  // which asks for 'prior_auth_required'. The last decision for a cell wins.
  const byCell = new Map<string, MergeDecision>();
  for (const d of args.decisions) {
    const cell = { ...d, attribute: libraryAttribute(d.attribute) };
    byCell.set(cellKey(cell), cell);
  }
  const decisions = [...byCell.values()];

  return withOrgContext(args.orgId, async (tx) => {
    // A rulebook built from the file alone is 'uploaded'; a file merged into
    // the rulebook the practice had is 'merged' ("reconciled against Pallio's
    // library" on the page).
    const rb = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO org_rulebook (org_id, origin, current_version, finalized_by_user_id)
      VALUES (${args.orgId}::uuid, 'uploaded', 1, ${args.byUserId}::uuid)
      ON CONFLICT (org_id) DO UPDATE SET
        origin = 'merged',
        current_version = org_rulebook.current_version + 1,
        finalized_by_user_id = ${args.byUserId}::uuid,
        updated_at = now()
      RETURNING id
    `;
    const rulebookId = rb[0]!.id;

    const held = await heldCells(tx, args.orgId, decisions);
    const toWrite = decisions.filter((d) => !held.has(cellKey(d)));

    const picks = toWrite.filter((d) => d.use === "library");
    const withPayer = picks.filter((d) => d.payerId !== null);
    const rules = await libraryRulesToday(tx, args.orgId, {
      payerIds: [...new Set(withPayer.map((d) => d.payerId!))],
      states: [...new Set(withPayer.map((d) => d.state))],
      codes: [...new Set(withPayer.map((d) => d.cptCode))],
    });
    const ruleFor = new Map(
      rules.map((r) => [cellKey({ payerId: r.payer_id, state: r.state, cptCode: r.code, attribute: r.attribute }), r]),
    );

    const cells = toWrite.map((d) => {
      const at = { payer_id: d.payerId, state: d.state, cpt_code: d.cptCode, attribute: d.attribute };
      if (d.use !== "library") {
        return {
          ...at, origin: "org_upload", rule_value: d.ruleValue, coverage_status: d.coverageStatus,
          confidence: UPLOADED_ROW_CONFIDENCE, source_payer_rule_id: null, source_quote: null,
        };
      }
      // The rule in force today, or the gap generation writes where there is none.
      const r = ruleFor.get(cellKey(d));
      return {
        ...at, origin: "source", rule_value: r?.rule_value ?? {}, coverage_status: r?.coverage_status ?? "unknown",
        confidence: r ? Number(r.confidence) : 0, source_payer_rule_id: r?.rule_id ?? null,
        source_quote: r?.source_quote ?? null,
      };
    });

    if (cells.length > 0) {
      const json = JSON.stringify(cells);
      // payer_id may be NULL (a payer the file names that matched none), and
      // the unique index never matches NULLs, hence IS NOT DISTINCT FROM and
      // no ON CONFLICT.
      await tx.$executeRaw`
        UPDATE org_rulebook_row r SET
          rule_value             = d.rule_value,
          coverage_status        = d.coverage_status,
          origin                 = d.origin,
          confidence             = d.confidence,
          source_payer_rule_id   = d.source_payer_rule_id,
          source_quote           = d.source_quote,
          expires_at             = NULL,
          source_attestation_id  = NULL,
          last_edited_by_user_id = ${args.byUserId}::uuid,
          last_edited_at         = now(),
          updated_at             = now()
          FROM jsonb_to_recordset(${json}::jsonb)
               AS d(payer_id uuid, state text, cpt_code text, attribute text, rule_value jsonb,
                    coverage_status text, origin text, confidence numeric,
                    source_payer_rule_id uuid, source_quote text)
         WHERE r.rulebook_id = ${rulebookId}::uuid
           AND r.payer_id IS NOT DISTINCT FROM d.payer_id
           AND r.state = d.state AND r.cpt_code = d.cpt_code AND r.attribute = d.attribute
           -- Never a person's decision; heldCells kept those out already.
           AND r.origin IN ('source', 'org_upload')
      `;
      await tx.$executeRaw`
        INSERT INTO org_rulebook_row (
          org_id, rulebook_id, payer_id, state, cpt_code, attribute,
          rule_value, coverage_status, origin, confidence,
          source_payer_rule_id, source_quote, last_edited_by_user_id, last_edited_at
        )
        SELECT ${args.orgId}::uuid, ${rulebookId}::uuid, d.payer_id, d.state, d.cpt_code, d.attribute,
               d.rule_value, d.coverage_status, d.origin, d.confidence,
               d.source_payer_rule_id, d.source_quote, ${args.byUserId}::uuid, now()
          FROM jsonb_to_recordset(${json}::jsonb)
               AS d(payer_id uuid, state text, cpt_code text, attribute text, rule_value jsonb,
                    coverage_status text, origin text, confidence numeric,
                    source_payer_rule_id uuid, source_quote text)
         WHERE NOT EXISTS (
           SELECT 1 FROM org_rulebook_row r
            WHERE r.rulebook_id = ${rulebookId}::uuid
              AND r.payer_id IS NOT DISTINCT FROM d.payer_id
              AND r.state = d.state AND r.cpt_code = d.cpt_code AND r.attribute = d.attribute
         )
      `;
    }

    await tx.$executeRaw`
      UPDATE rulebook_upload
         SET status = 'merged', updated_at = now()
       WHERE id = ${args.uploadId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    return { merged: toWrite.length, fromLibrary: picks.length, kept: held.size };
  });
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
    if (!upload[0]) throw new NotFoundError("Upload not found.");
    const parsed = (upload[0].parsed_rows as unknown[]) as Array<{
      payerId: string | null;
      state: string;
      cptCode: string;
      attribute: string;
      coverageStatus: CoverageStatus;
      ruleValue: Record<string, unknown>;
    }>;

    if (parsed.length === 0) return [];

    // The file's attribute names are the lookup's short ones ('prior_auth');
    // the library's are 'prior_auth_required'. Compared as written, six of the
    // ten never met the library's rule, and each came back twice: the
    // upload's row "unverified" and the library's "new from Pallio".
    const orgRows = parsed.map((r) => ({ ...r, attribute: libraryAttribute(r.attribute) }));

    const payerIds = Array.from(
      new Set(orgRows.map((r) => r.payerId).filter((v): v is string => !!v)),
    );
    const states = Array.from(new Set(orgRows.map((r) => r.state)));
    const cpts = Array.from(new Set(orgRows.map((r) => r.cptCode)));

    const sourceRows = await libraryRulesToday(tx, args.orgId, { payerIds, states, codes: cpts });

    const rows = compareRulebooks({
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

    // A merge leaves a cell someone already decided; say which before anyone applies.
    const held = await heldCells(tx, args.orgId, rows);
    return rows.map((r) => {
      const keptAs = held.get(cellKey(r));
      return keptAs ? { ...r, keptAs } : r;
    });
  });
}
