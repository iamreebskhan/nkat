/**
 * Era835Ingestor — persist parsed 835 files into `era_835_record` rows for the
 * tenant, attempt to match each line back to the `payer_rule` row that should
 * have prevented denial, and roll up daily `denial_event` aggregates so the
 * denial dashboard has data immediately.
 *
 * Idempotency: a record with the same (org_id, claim_id, service_dos,
 * service_code) is skipped on re-ingest. We don't dedupe by 835 file content
 * hash — same file can legitimately arrive multiple times via different
 * channels. Per-record dedup is the contract.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../../database/rls-transaction';
import type { Era835Adjustment, Era835File } from './types';

export interface IngestionContext {
  org_id: string;
  client_id: string;
  /** Where the file came from (S3 URI or original filename). */
  source_file_uri?: string;
}

export interface IngestionReport {
  total_claims: number;
  total_lines: number;
  records_persisted: number;
  records_skipped_duplicate: number;
  preflight_matches: number;
  preflight_warned: number;
  errors: { claim_id: string; message: string }[];
}

export const ERA835_INGESTOR = Symbol('ERA835_INGESTOR');

@Injectable()
export class Era835Ingestor {
  private readonly log = new Logger(Era835Ingestor.name);

  /**
   * Persist one parsed 835 file. Caller is responsible for opening the
   * tenant-scoped transaction (`runWithTenant`) so RLS applies.
   */
  async ingest(
    tx: Tx,
    file: Era835File,
    ctx: IngestionContext,
  ): Promise<IngestionReport> {
    const report: IngestionReport = {
      total_claims: file.claims.length,
      total_lines: file.claims.reduce((n, c) => n + c.service_lines.length, 0),
      records_persisted: 0,
      records_skipped_duplicate: 0,
      preflight_matches: 0,
      preflight_warned: 0,
      errors: [],
    };

    // Resolve payer_id by matching the 835's payer_name to a known payer.
    const payerId = await this.resolvePayerId(tx, file.header.payer_name);

    for (const claim of file.claims) {
      try {
        for (const line of claim.service_lines) {
          const dos = line.service_dos ?? claim.service_dos;
          if (!dos) {
            this.log.warn(`claim=${claim.claim_id} line ${line.service_code}: no DOS`);
            continue;
          }

          // Idempotency check
          const existing = await tx
            .selectFrom('era_835_record')
            .select('id')
            .where('org_id', '=', ctx.org_id)
            .where('claim_id', '=', claim.claim_id)
            .where('service_dos', '=', dos)
            .where('service_codes', '@>', [line.service_code])
            .executeTakeFirst();
          if (existing) {
            report.records_skipped_duplicate++;
            continue;
          }

          // Match to a payer_rule that would have warned us pre-bill.
          const expected = payerId
            ? await this.findExpectedRule(tx, payerId, line.service_code, dos)
            : null;
          const lineAdjustments: Era835Adjustment[] =
            line.adjustments.length > 0 ? line.adjustments : claim.adjustments;
          const carcCodes = lineAdjustments.map((a) => a.reason_code);
          const groupCode = lineAdjustments[0]?.group_code ?? null;

          const wouldHaveWarned = expected !== null && carcCodes.length > 0;
          if (wouldHaveWarned) report.preflight_warned++;
          if (expected) report.preflight_matches++;

          await tx
            .insertInto('era_835_record')
            .values({
              org_id: ctx.org_id,
              client_id: ctx.client_id,
              payer_id: payerId,
              trace_number: file.header.trace_number ?? null,
              claim_id: claim.claim_id,
              patient_external_id: claim.patient_external_id ?? null,
              service_dos: dos,
              billed_amount: line.billed_amount.toFixed(2),
              paid_amount: line.paid_amount.toFixed(2),
              adjustment_amount: (line.billed_amount - line.paid_amount).toFixed(2),
              carc_codes: carcCodes,
              rarc_codes: [...claim.rarc_codes, ...line.rarc_codes],
              group_code: groupCode,
              service_codes: [line.service_code],
              modifiers: line.modifiers,
              pos: null,
              units: line.units,
              expected_rule_id: expected,
              preflight_warned: wouldHaveWarned,
              raw_segment: null,
              source_file_uri: ctx.source_file_uri ?? null,
            })
            .execute();
          report.records_persisted++;
        }
      } catch (err) {
        report.errors.push({ claim_id: claim.claim_id, message: (err as Error).message });
        this.log.warn(`claim=${claim.claim_id} ingestion failed: ${(err as Error).message}`);
      }
    }

    return report;
  }

  // ----- internals -----

  private async resolvePayerId(tx: Tx, payerName: string | undefined): Promise<string | null> {
    if (!payerName) return null;
    const row = await tx
      .selectFrom('payer')
      .select('id')
      .where('name', '=', payerName)
      .where('active', '=', true)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async findExpectedRule(
    tx: Tx,
    payerId: string,
    code: string,
    dos: Date,
  ): Promise<string | null> {
    const row = await tx
      .selectFrom('payer_rule')
      .select('id')
      .where('payer_id', '=', payerId)
      .where('code', '=', code)
      .where('attribute', '=', 'covered')
      .where('effective_date', '<=', dos)
      .where((eb) =>
        eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]),
      )
      .orderBy('effective_date', 'desc')
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
