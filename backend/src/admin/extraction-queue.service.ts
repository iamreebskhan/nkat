/**
 * ExtractionQueueService — analyst review pipeline.
 *
 *   enqueue()   — extractor proposes a payer_rule via extraction_candidate.
 *   nextBatch() — analyst pulls the highest-priority unclaimed candidates.
 *   claim()     — atomically transitions queued → claimed for one analyst.
 *   accept()    — analyst approves; we INSERT the corresponding payer_rule
 *                 and link it back via resulting_rule_id.
 *   reject()    — analyst rejects; status flips to 'rejected'.
 *   edit()      — analyst edits before accepting; we INSERT the edited
 *                 payer_rule and record the edits in extraction_decision.
 *
 * `extraction_decision` is append-only. We never UPDATE a candidate's
 * decision history; new decisions add new rows.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import type {
  CoverageStatus,
  PayerRuleAttribute,
} from '../database/schema.types';

export interface EnqueueInput {
  source_doc_id: string;
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  proposed_value: Record<string, unknown>;
  proposed_coverage_status: CoverageStatus;
  proposed_confidence: number;
  proposed_effective_date: Date;
  proposed_expiration_date?: Date;
  proposed_provider_taxonomy_allowed?: string[];
  proposed_timely_filing_days?: number;
  proposed_mhpaea_paired_code?: string;
  source_quote?: string;
  source_page?: number;
  extractor_name: string;
  extractor_run_id?: string;
  priority?: number;
}

export interface EditPayload {
  edited_value: Record<string, unknown>;
  edited_coverage_status: CoverageStatus;
  edited_confidence: number;
}

export interface CandidateSummary {
  id: string;
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  proposed_coverage_status: CoverageStatus;
  proposed_confidence: number;
  status: string;
  priority: number;
  source_doc_id: string;
  extractor_name: string;
  source_quote: string | null;
  created_at: Date;
}

export class CandidateNotInQueueError extends Error {
  constructor(candidateId: string) {
    super(`Candidate ${candidateId} is not in 'queued' or 'claimed' state`);
    this.name = 'CandidateNotInQueueError';
  }
}

@Injectable()
export class ExtractionQueueService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async enqueue(input: EnqueueInput): Promise<string> {
    const inserted = await this.db
      .insertInto('extraction_candidate')
      .values({
        source_doc_id: input.source_doc_id,
        payer_id: input.payer_id,
        state: input.state,
        product_line: input.product_line,
        code: input.code,
        attribute: input.attribute,
        proposed_value: sql`${JSON.stringify(input.proposed_value)}::jsonb`,
        proposed_coverage_status: input.proposed_coverage_status,
        proposed_confidence: input.proposed_confidence.toFixed(2),
        proposed_effective_date: input.proposed_effective_date,
        proposed_expiration_date: input.proposed_expiration_date ?? null,
        proposed_provider_taxonomy_allowed: input.proposed_provider_taxonomy_allowed ?? [],
        proposed_timely_filing_days: input.proposed_timely_filing_days ?? null,
        proposed_mhpaea_paired_code: input.proposed_mhpaea_paired_code ?? null,
        source_quote: input.source_quote ?? null,
        source_page: input.source_page ?? null,
        extractor_name: input.extractor_name,
        extractor_run_id: input.extractor_run_id ?? null,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  async nextBatch(limit = 10): Promise<CandidateSummary[]> {
    const rows = await this.db
      .selectFrom('extraction_candidate')
      .where('status', '=', 'queued')
      .select([
        'id',
        'payer_id',
        'state',
        'product_line',
        'code',
        'attribute',
        'proposed_coverage_status',
        'proposed_confidence',
        'status',
        'priority',
        'source_doc_id',
        'extractor_name',
        'source_quote',
        'created_at',
      ])
      .orderBy('priority', 'desc')
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      payer_id: r.payer_id,
      state: r.state,
      product_line: r.product_line,
      code: r.code,
      attribute: r.attribute,
      proposed_coverage_status: r.proposed_coverage_status,
      proposed_confidence: Number(r.proposed_confidence),
      status: r.status,
      priority: r.priority,
      source_doc_id: r.source_doc_id,
      extractor_name: r.extractor_name,
      source_quote: r.source_quote,
      created_at: r.created_at,
    }));
  }

  /**
   * Atomic claim: transitions queued → claimed in a single UPDATE … WHERE
   * status='queued', so two analysts can't both grab the same row.
   */
  async claim(candidateId: string, analystEmail: string): Promise<boolean> {
    const result = await this.db
      .updateTable('extraction_candidate')
      .set({ status: 'claimed', claimed_by: analystEmail, claimed_at: new Date() })
      .where('id', '=', candidateId)
      .where('status', '=', 'queued')
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) === 1;
  }

  async accept(candidateId: string, analystEmail: string, rationale?: string, attestationCall?: Record<string, unknown>): Promise<string> {
    return this.db.transaction().execute(async (tx) => {
      const cand = await tx
        .selectFrom('extraction_candidate')
        .selectAll()
        .where('id', '=', candidateId)
        .executeTakeFirst();
      if (!cand) throw new CandidateNotInQueueError(candidateId);
      if (cand.status !== 'queued' && cand.status !== 'claimed') {
        throw new CandidateNotInQueueError(candidateId);
      }

      // Insert the corresponding payer_rule.
      const inserted = await tx
        .insertInto('payer_rule')
        .values({
          payer_id: cand.payer_id,
          state: cand.state,
          product_line: cand.product_line,
          code: cand.code,
          attribute: cand.attribute,
          value: sql`${JSON.stringify(cand.proposed_value)}::jsonb`,
          coverage_status: cand.proposed_coverage_status,
          confidence: cand.proposed_confidence,
          effective_date: cand.proposed_effective_date,
          expiration_date: cand.proposed_expiration_date,
          source_doc_id: cand.source_doc_id,
          source_quote: cand.source_quote,
          source_page: cand.source_page,
          documentation_requirement_id: null,
          provider_taxonomy_allowed: cand.proposed_provider_taxonomy_allowed,
          timely_filing_days: cand.proposed_timely_filing_days,
          mhpaea_paired_code: cand.proposed_mhpaea_paired_code,
          created_by: `analyst:${analystEmail}`,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('extraction_candidate')
        .set({ status: 'accepted', resulting_rule_id: inserted.id })
        .where('id', '=', candidateId)
        .execute();

      await tx
        .insertInto('extraction_decision')
        .values({
          candidate_id: candidateId,
          decision: 'accept',
          edited_value: null,
          edited_coverage_status: null,
          edited_confidence: null,
          rationale: rationale ?? null,
          attestation_call: attestationCall
            ? sql`${JSON.stringify(attestationCall)}::jsonb`
            : null,
          decided_by: analystEmail,
        })
        .execute();

      return inserted.id;
    });
  }

  async reject(candidateId: string, analystEmail: string, rationale: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const result = await tx
        .updateTable('extraction_candidate')
        .set({ status: 'rejected' })
        .where('id', '=', candidateId)
        .where('status', 'in', ['queued', 'claimed'])
        .executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0) !== 1) {
        throw new CandidateNotInQueueError(candidateId);
      }
      await tx
        .insertInto('extraction_decision')
        .values({
          candidate_id: candidateId,
          decision: 'reject',
          edited_value: null,
          edited_coverage_status: null,
          edited_confidence: null,
          rationale,
          attestation_call: null,
          decided_by: analystEmail,
        })
        .execute();
    });
  }

  async edit(
    candidateId: string,
    analystEmail: string,
    edits: EditPayload,
    rationale?: string,
  ): Promise<string> {
    return this.db.transaction().execute(async (tx) => {
      const cand = await tx
        .selectFrom('extraction_candidate')
        .selectAll()
        .where('id', '=', candidateId)
        .executeTakeFirst();
      if (!cand) throw new CandidateNotInQueueError(candidateId);
      if (cand.status !== 'queued' && cand.status !== 'claimed') {
        throw new CandidateNotInQueueError(candidateId);
      }

      const inserted = await tx
        .insertInto('payer_rule')
        .values({
          payer_id: cand.payer_id,
          state: cand.state,
          product_line: cand.product_line,
          code: cand.code,
          attribute: cand.attribute,
          value: sql`${JSON.stringify(edits.edited_value)}::jsonb`,
          coverage_status: edits.edited_coverage_status,
          confidence: edits.edited_confidence.toFixed(2),
          effective_date: cand.proposed_effective_date,
          expiration_date: cand.proposed_expiration_date,
          source_doc_id: cand.source_doc_id,
          source_quote: cand.source_quote,
          source_page: cand.source_page,
          documentation_requirement_id: null,
          provider_taxonomy_allowed: cand.proposed_provider_taxonomy_allowed,
          timely_filing_days: cand.proposed_timely_filing_days,
          mhpaea_paired_code: cand.proposed_mhpaea_paired_code,
          created_by: `analyst-edit:${analystEmail}`,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('extraction_candidate')
        .set({ status: 'edited', resulting_rule_id: inserted.id })
        .where('id', '=', candidateId)
        .execute();

      await tx
        .insertInto('extraction_decision')
        .values({
          candidate_id: candidateId,
          decision: 'edit',
          edited_value: sql`${JSON.stringify(edits.edited_value)}::jsonb`,
          edited_coverage_status: edits.edited_coverage_status,
          edited_confidence: edits.edited_confidence.toFixed(2),
          rationale: rationale ?? null,
          attestation_call: null,
          decided_by: analystEmail,
        })
        .execute();

      return inserted.id;
    });
  }
}
