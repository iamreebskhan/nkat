/**
 * NcdLcdIngestor — pulls LCDs + LCD articles for a target code set from the
 * CMS Coverage API and persists them as source_document + payer_rule rows.
 *
 * Mapping (Phase 1, Medicare-only):
 *   - For each LCD/article that mentions a target CPT/HCPCS:
 *       INSERT a source_document row (hash-deduped against content_hash).
 *       INSERT payer_rule rows:
 *         attribute='covered'                  if cpt is in cpt_codes / hcpcs_codes
 *         attribute='medical_necessity_icd10'  with value.codes = icd10_covered[]
 *
 *   - confidence = 1.0 (source is the authoritative CMS API).
 *   - effective_date = LCD effective_date.
 *   - source_quote = first 240 chars of body_html stripped of tags.
 *
 * The ingestor is idempotent on content_hash; re-running with unchanged data
 * is a no-op.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import type { CmsCoverageApiClient, CmsLcdDetail } from './cms-coverage-api.client';

export interface IngestionTarget {
  payer_id: string;
  payer_name: string; // for log clarity
  state: string;
  product_line: 'medicare_ffs' | 'medicare_advantage';
  codes: string[];
  effective_on?: Date;
}

export interface IngestionReport {
  target: IngestionTarget;
  lcds_seen: number;
  documents_persisted: number;
  rules_persisted: number;
  errors: { lcd_id: string; message: string }[];
}

const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

@Injectable()
export class NcdLcdIngestor {
  private readonly log = new Logger(NcdLcdIngestor.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject('CMS_CLIENT') private readonly cms: CmsCoverageApiClient,
  ) {}

  async ingest(target: IngestionTarget): Promise<IngestionReport> {
    const report: IngestionReport = {
      target,
      lcds_seen: 0,
      documents_persisted: 0,
      rules_persisted: 0,
      errors: [],
    };
    const seenLcdIds = new Set<string>();

    for (const code of target.codes) {
      const summaries = await this.cms.listLcds({
        state: target.state,
        cpt: code,
        ...(target.effective_on
          ? { effectiveOn: target.effective_on.toISOString().slice(0, 10) }
          : {}),
      });
      for (const s of summaries) {
        if (seenLcdIds.has(s.lcd_id)) continue;
        seenLcdIds.add(s.lcd_id);
        report.lcds_seen++;
        try {
          const detail = await this.cms.getLcd(s.lcd_id);
          const persisted = await this.persistOne(target, detail);
          report.documents_persisted += persisted.docInserted ? 1 : 0;
          report.rules_persisted += persisted.rulesInserted;
        } catch (err) {
          report.errors.push({ lcd_id: s.lcd_id, message: (err as Error).message });
          this.log.warn(`LCD ${s.lcd_id} ingestion failed: ${(err as Error).message}`);
        }
      }
    }
    return report;
  }

  /** Visible for tests. */
  async persistOne(
    target: IngestionTarget,
    detail: CmsLcdDetail,
  ): Promise<{ docInserted: boolean; rulesInserted: number; sourceDocId: string }> {
    const contentHash = sha256(detail.body_html);

    // Upsert source_document on content_hash → idempotent re-runs.
    const docRow = await this.db
      .selectFrom('source_document')
      .select(['id'])
      .where('content_hash', '=', contentHash)
      .where('document_type', '=', 'lcd')
      .executeTakeFirst();

    let sourceDocId: string;
    let docInserted = false;
    if (docRow) {
      sourceDocId = docRow.id;
    } else {
      const inserted = await this.db
        .insertInto('source_document')
        .values({
          payer_id: target.payer_id,
          url: detail.url,
          document_type: 'lcd',
          title: detail.title,
          effective_date: new Date(detail.effective_date),
          retrieved_at: new Date(),
          content_hash: contentHash,
          storage_uri: null,
          cms_license_token_used: true,
          source_metadata: sql`${JSON.stringify({
            lcd_id: detail.lcd_id,
            contractor: detail.contractor,
          })}::jsonb`,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      sourceDocId = inserted.id;
      docInserted = true;
    }

    let rulesInserted = 0;
    const targetCodeSet = new Set(target.codes);
    const matchingCodes = [
      ...detail.cpt_codes.filter((c) => targetCodeSet.has(c)),
      ...detail.hcpcs_codes.filter((c) => targetCodeSet.has(c)),
    ];

    const sourceQuote = stripHtml(detail.body_html).slice(0, 240);

    for (const code of matchingCodes) {
      // attribute='covered'
      await this.db
        .insertInto('payer_rule')
        .values({
          payer_id: target.payer_id,
          state: target.state,
          product_line: target.product_line,
          code,
          attribute: 'covered',
          value: sql`'true'::jsonb`,
          coverage_status: 'covered',
          confidence: '1.00',
          effective_date: new Date(detail.effective_date),
          expiration_date: detail.retirement_date ? new Date(detail.retirement_date) : null,
          source_doc_id: sourceDocId,
          source_quote: sourceQuote,
          source_page: null,
          documentation_requirement_id: null,
          provider_taxonomy_allowed: [],
          timely_filing_days: null,
          mhpaea_paired_code: null,
          created_by: 'ingestor:cms_coverage_api',
        })
        .execute();
      rulesInserted++;

      // attribute='medical_necessity_icd10' with the LCD's covered ICD-10 list
      if (detail.icd10_covered.length > 0) {
        await this.db
          .insertInto('payer_rule')
          .values({
            payer_id: target.payer_id,
            state: target.state,
            product_line: target.product_line,
            code,
            attribute: 'medical_necessity_icd10',
            value: sql`${JSON.stringify({ codes: detail.icd10_covered })}::jsonb`,
            coverage_status: 'covered',
            confidence: '1.00',
            effective_date: new Date(detail.effective_date),
            expiration_date: detail.retirement_date ? new Date(detail.retirement_date) : null,
            source_doc_id: sourceDocId,
            source_quote: sourceQuote,
            source_page: null,
            documentation_requirement_id: null,
            provider_taxonomy_allowed: [],
            timely_filing_days: null,
            mhpaea_paired_code: null,
            created_by: 'ingestor:cms_coverage_api',
          })
          .execute();
        rulesInserted++;
      }
    }

    return { docInserted, rulesInserted, sourceDocId };
  }
}
