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

  for (const src of due) {
    try {
      const r = await ingestDocumentFromUrl({
        url: src.url,
        payerId: src.payer_id,
        state: src.state,
        documentType: src.document_type as IngestableDocumentType,
        title: src.name,
      });
      const changed = r.contentHash !== src.last_content_hash;
      if (r.alreadyIngested) unchanged++;
      else if (changed) ingested++;
      else unchanged++;
      await withBreakglass(async (tx) => {
        await tx.$executeRaw`
          UPDATE ingestion_source SET
            last_check_at     = now(),
            last_content_hash = ${r.contentHash},
            last_ingested_at  = CASE WHEN ${changed} THEN now() ELSE last_ingested_at END,
            last_error        = NULL,
            updated_at        = now()
          WHERE id = ${src.id}::uuid
        `;
      }, "ingestion-cron: update bookkeeping");
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      await withBreakglass(async (tx) => {
        await tx.$executeRaw`
          UPDATE ingestion_source SET
            last_check_at = now(),
            last_error    = ${msg.slice(0, 500)},
            updated_at    = now()
          WHERE id = ${src.id}::uuid
        `;
      }, "ingestion-cron: record error");
    }
  }

  return { checked: due.length, ingested, unchanged, errors };
}
