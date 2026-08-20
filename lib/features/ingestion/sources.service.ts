/**
 * Operator-managed ingestion source registry — Sources 1 & 2 config.
 *
 * Reads/writes the `ingestion_source` table (no RLS — platform
 * operators only; route is gated on a platform-admin permission).
 *
 * The cron route (POST /api/cron/ingest-documents) picks rows due
 * for re-check, fetches them via document-ingestion.service.ts, and
 * updates last_content_hash/last_check_at/last_error.
 */
import { z } from "zod";

import { NotFoundError } from "@/lib/api";
import { withBreakglass } from "@/lib/db";
import {
  ingestDocumentFromUrl,
  type IngestableDocumentType,
} from "./document-ingestion.service";

const DOCUMENT_TYPES = [
  "medical_policy",
  "reimbursement_policy",
  "provider_manual",
  "mln_article",
  "ncd",
  "lcd",
  "lcd_article",
  "cms_pfs",
  "cms_coverage_api",
  "hcpcs_release",
  "ncci_release",
  "state_medicaid_manual",
  "wc_fee_schedule",
  "ihs_rate",
] as const;
export const DocumentTypeSchema = z.enum(DOCUMENT_TYPES);

export const CreateSourceSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  payerId: z.string().uuid().nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  documentType: DocumentTypeSchema,
  scheduleCadence: z.enum(["daily", "weekly", "monthly"]).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateSourceInput = z.infer<typeof CreateSourceSchema>;

export interface IngestionSourceView {
  id: string;
  name: string;
  url: string;
  payerId: string | null;
  state: string | null;
  documentType: string;
  scheduleCadence: string;
  lastContentHash: string | null;
  lastCheckAt: string | null;
  lastIngestedAt: string | null;
  lastError: string | null;
  active: boolean;
  notes: string | null;
}

interface Row {
  id: string;
  name: string;
  url: string;
  payer_id: string | null;
  state: string | null;
  document_type: string;
  schedule_cadence: string;
  last_content_hash: string | null;
  last_check_at: Date | null;
  last_ingested_at: Date | null;
  last_error: string | null;
  active: boolean;
  notes: string | null;
  // Added in migration 0066 — see runIngestionCron for how these drive
  // the review gate and the source-health view.
  auto_extract: boolean;
  review_pending: boolean;
  last_rule_count: number | null;
  consecutive_failures: number;
}

function toView(r: Row): IngestionSourceView {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    payerId: r.payer_id,
    state: r.state,
    documentType: r.document_type,
    scheduleCadence: r.schedule_cadence,
    lastContentHash: r.last_content_hash,
    lastCheckAt: r.last_check_at?.toISOString() ?? null,
    lastIngestedAt: r.last_ingested_at?.toISOString() ?? null,
    lastError: r.last_error,
    active: r.active,
    notes: r.notes,
  };
}

export async function createSource(input: CreateSourceInput): Promise<IngestionSourceView> {
  return withBreakglass(async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO ingestion_source (
        name, url, payer_id, state, document_type, schedule_cadence, notes
      ) VALUES (
        ${input.name}, ${input.url},
        ${input.payerId ?? null}::uuid,
        ${input.state ?? null},
        ${input.documentType},
        ${input.scheduleCadence ?? "weekly"},
        ${input.notes ?? null}
      )
      ON CONFLICT (url) DO UPDATE SET
        name = EXCLUDED.name,
        payer_id = EXCLUDED.payer_id,
        state = EXCLUDED.state,
        document_type = EXCLUDED.document_type,
        schedule_cadence = EXCLUDED.schedule_cadence,
        notes = EXCLUDED.notes,
        updated_at = now()
      RETURNING *
    `;
    return toView(rows[0]!);
  }, "ingestion-source upsert (platform admin)");
}

/**
 * Edit one source. Every field optional; only what is provided changes.
 *
 * There was no way to do this. An operator could register a source and then
 * never touch it again — no edit, no deactivate, no delete, only "Run now".
 * A source pointed at the wrong payer, or at a test fixture, was permanent
 * from the UI, and the only remedy was SQL on the box. That is how the
 * fixture source that displaced ten Medicare rules stayed registered.
 */
export const UpdateSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2000).optional(),
  payerId: z.string().uuid().nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  documentType: DocumentTypeSchema.optional(),
  scheduleCadence: z.enum(["daily", "weekly", "monthly"]).optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Pause a source without losing its history. */
  active: z.boolean().optional(),
});
export type UpdateSourceInput = z.infer<typeof UpdateSourceSchema>;

export async function updateSource(
  id: string,
  input: UpdateSourceInput,
): Promise<IngestionSourceView> {
  return withBreakglass(async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE ingestion_source SET
        name             = COALESCE(${input.name ?? null}, name),
        url              = COALESCE(${input.url ?? null}, url),
        payer_id         = CASE WHEN ${input.payerId === undefined}
                                THEN payer_id ELSE ${input.payerId ?? null}::uuid END,
        state            = CASE WHEN ${input.state === undefined}
                                THEN state ELSE ${input.state ?? null} END,
        document_type    = COALESCE(${input.documentType ?? null}, document_type),
        schedule_cadence = COALESCE(${input.scheduleCadence ?? null}, schedule_cadence),
        notes            = CASE WHEN ${input.notes === undefined}
                                THEN notes ELSE ${input.notes ?? null} END,
        active           = COALESCE(${input.active ?? null}::boolean, active),
        updated_at       = now()
      WHERE id = ${id}::uuid
      RETURNING *
    `;
    if (!rows[0]) throw new NotFoundError("Ingestion source not found.");
    return toView(rows[0]);
  }, "ingestion-source update (platform admin)");
}

/**
 * Delete a source. The documents and rules it already produced are left
 * alone on purpose: they are cited by live rules, and removing the record of
 * where an answer came from to tidy up a config row would be the worse bug.
 * This only stops future re-checks.
 */
export async function deleteSource(id: string): Promise<{ deleted: boolean }> {
  return withBreakglass(async (tx) => {
    const n = await tx.$executeRaw`
      DELETE FROM ingestion_source WHERE id = ${id}::uuid
    `;
    if (n === 0) throw new NotFoundError("Ingestion source not found.");
    return { deleted: true };
  }, "ingestion-source delete (platform admin)");
}

export async function listSources(): Promise<IngestionSourceView[]> {
  return withBreakglass(async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT * FROM ingestion_source ORDER BY created_at DESC
    `;
    return rows.map(toView);
  }, "ingestion-source list (platform admin)");
}

/**
 * Cron entrypoint: fetch every active source whose last_check_at is
 * older than its cadence, re-ingest if content_hash changed, update
 * bookkeeping. Best-effort per source: a failing URL is logged and
 * skipped, never aborts the whole batch.
 */
export async function runIngestionCron(): Promise<{
  checked: number;
  ingested: number;
  unchanged: number;
  errors: number;
  /** Sources whose content moved but which are gated on human review. */
  flaggedForReview: number;
}> {
  const due = await withBreakglass(async (tx) => {
    return tx.$queryRaw<Row[]>`
      SELECT * FROM ingestion_source
       WHERE active = TRUE
         AND (
           last_check_at IS NULL
           OR (schedule_cadence = 'daily'   AND last_check_at < now() - INTERVAL '1 day')
           OR (schedule_cadence = 'weekly'  AND last_check_at < now() - INTERVAL '7 days')
           OR (schedule_cadence = 'monthly' AND last_check_at < now() - INTERVAL '30 days')
         )
       ORDER BY last_check_at NULLS FIRST
       LIMIT 50
    `;
  }, "ingestion-cron: list due sources");

  let ingested = 0;
  let unchanged = 0;
  let errors = 0;

  let flaggedForReview = 0;

  for (const src of due) {
    try {
      // auto_extract = FALSE: detect the change, write nothing. One HTTP
      // fetch, no Claude call. A change raises review_pending so the
      // grounded offline extraction can run against it before anything
      // reaches the shared library.
      const detectOnly = src.auto_extract === false;

      const r = await ingestDocumentFromUrl({
        url: src.url,
        payerId: src.payer_id,
        state: src.state,
        documentType: src.document_type as IngestableDocumentType,
        title: src.name,
        detectOnly,
      });

      const changed = r.contentHash !== src.last_content_hash;
      if (detectOnly) {
        if (changed) flaggedForReview++;
        else unchanged++;
      } else if (r.alreadyIngested) unchanged++;
      else if (changed) ingested++;
      else unchanged++;

      await withBreakglass(async (tx) => {
        await tx.$executeRaw`
          UPDATE ingestion_source SET
            last_check_at           = now(),
            last_content_hash       = ${r.contentHash},
            last_ingested_at        = CASE WHEN ${changed} AND NOT ${detectOnly}
                                            THEN now() ELSE last_ingested_at END,
            -- Distinguishes "checked, genuinely unchanged" from "not
            -- looked at in a year" — the health view needs both.
            last_change_detected_at = CASE WHEN ${changed}
                                            THEN now() ELSE last_change_detected_at END,
            -- A fall to 0 on a source that used to yield rules means the
            -- document was restructured; without this it looks identical
            -- to a healthy no-op.
            --
            -- ONLY RECORDED WHEN AN EXTRACTION ACTUALLY RAN. It already
            -- skipped detect-only passes, but not the far more common case:
            -- an unchanged document short-circuits on alreadyIngested and
            -- returns ruleCount 0 WITHOUT extracting anything. Writing that
            -- 0 overwrote the real count from the last genuine extraction, so
            -- the health view classified the source no_rules and told the
            -- operator "Last extraction produced no rules — the document may
            -- have been restructured" about a document that was never read.
            --
            -- That is why 22 of 27 sources looked broken. They are not: they
            -- are unchanged, correctly not re-extracted, and were being
            -- reported as failures for doing exactly the right thing. Every
            -- weekly cron pass reset the count and re-condemned them.
            last_rule_count         = CASE WHEN ${detectOnly} OR ${r.alreadyIngested}
                                            THEN last_rule_count ELSE ${r.ruleCount} END,
            review_pending          = CASE WHEN ${detectOnly} AND ${changed}
                                            THEN TRUE ELSE review_pending END,
            consecutive_failures    = 0,
            last_error              = NULL,
            updated_at              = now()
          WHERE id = ${src.id}::uuid
        `;
      }, "ingestion-cron: update bookkeeping");
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      await withBreakglass(async (tx) => {
        await tx.$executeRaw`
          UPDATE ingestion_source SET
            last_check_at        = now(),
            last_error           = ${msg.slice(0, 500)},
            -- Counts up so a dead source (moved, 404, TLS failure) can be
            -- told apart from a flaky one and surfaced rather than
            -- retried in silence forever.
            consecutive_failures = consecutive_failures + 1,
            updated_at           = now()
          WHERE id = ${src.id}::uuid
        `;
      }, "ingestion-cron: record error");
    }
  }

  return { checked: due.length, ingested, unchanged, errors, flaggedForReview };
}
