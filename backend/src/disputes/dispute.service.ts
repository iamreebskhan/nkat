/**
 * DisputeService — customer "this rule is wrong" workflow.
 *
 *   submit()      — customer submits a dispute; tenant-scoped (RLS).
 *   resolveRight() — analyst confirms our rule is correct; mark resolved.
 *   resolveWrong() — analyst confirms our rule is wrong; spawns an
 *                    extraction_candidate at elevated priority and links it
 *                    via resulting_candidate_id.
 *
 * Append-only resolution; we never edit the customer's submitted assertion.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runWithTenant } from '../database/rls-transaction';
import type { CoverageStatus, PayerRuleAttribute } from '../database/schema.types';

export interface SubmitDisputeInput {
  org_id: string;
  user_id: string | null;
  payer_rule_id?: string;
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  customer_assertion: Record<string, unknown>;
  evidence_url?: string;
  customer_notes?: string;
}

export interface ResolveWrongInput {
  org_id: string;
  dispute_id: string;
  analyst_email: string;
  proposed_value: Record<string, unknown>;
  proposed_coverage_status: CoverageStatus;
  proposed_confidence: number;
  proposed_effective_date: Date;
  resolution_notes?: string;
  source_doc_id: string;
  source_quote?: string;
}

export class DisputeNotFoundError extends Error {
  constructor(id: string) {
    super(`Dispute ${id} not found in this tenant`);
    this.name = 'DisputeNotFoundError';
  }
}

@Injectable()
export class DisputeService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async submit(input: SubmitDisputeInput): Promise<string> {
    return runWithTenant(this.db, input.org_id, async (tx) => {
      const inserted = await tx
        .insertInto('rule_dispute')
        .values({
          org_id: input.org_id,
          user_id: input.user_id,
          payer_rule_id: input.payer_rule_id ?? null,
          payer_id: input.payer_id,
          state: input.state,
          product_line: input.product_line,
          code: input.code,
          attribute: input.attribute,
          customer_assertion: sql`${JSON.stringify(input.customer_assertion)}::jsonb`,
          evidence_url: input.evidence_url ?? null,
          customer_notes: input.customer_notes ?? null,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      return inserted.id;
    });
  }

  async resolveRight(orgId: string, disputeId: string, notes: string): Promise<void> {
    await runWithTenant(this.db, orgId, async (tx) => {
      const updated = await tx
        .updateTable('rule_dispute')
        .set({ status: 'resolved_we_were_right', resolution_notes: notes, resolved_at: new Date() })
        .where('id', '=', disputeId)
        .where('status', 'in', ['open', 'investigating'])
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) !== 1) throw new DisputeNotFoundError(disputeId);
    });
  }

  async resolveWrong(input: ResolveWrongInput): Promise<{ candidate_id: string }> {
    return runWithTenant(this.db, input.org_id, async (tx) => {
      const dispute = await tx
        .selectFrom('rule_dispute')
        .selectAll()
        .where('id', '=', input.dispute_id)
        .executeTakeFirst();
      if (!dispute) throw new DisputeNotFoundError(input.dispute_id);
      if (!['open', 'investigating'].includes(dispute.status)) {
        throw new DisputeNotFoundError(input.dispute_id);
      }

      const candidate = await tx
        .insertInto('extraction_candidate')
        .values({
          source_doc_id: input.source_doc_id,
          payer_id: dispute.payer_id,
          state: dispute.state,
          product_line: dispute.product_line,
          code: dispute.code,
          attribute: dispute.attribute,
          proposed_value: sql`${JSON.stringify(input.proposed_value)}::jsonb`,
          proposed_coverage_status: input.proposed_coverage_status,
          proposed_confidence: input.proposed_confidence.toFixed(2),
          proposed_effective_date: input.proposed_effective_date,
          proposed_expiration_date: null,
          proposed_provider_taxonomy_allowed: [],
          proposed_timely_filing_days: null,
          proposed_mhpaea_paired_code: null,
          source_quote: input.source_quote ?? null,
          source_page: null,
          extractor_name: 'dispute_resolution',
          extractor_run_id: input.dispute_id,
          priority: 95,                                  // customer-disputed = top priority
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('rule_dispute')
        .set({
          status: 'resolved_we_were_wrong',
          resolution_notes: input.resolution_notes ?? null,
          resolved_at: new Date(),
          resulting_candidate_id: candidate.id,
        })
        .where('id', '=', input.dispute_id)
        .execute();

      return { candidate_id: candidate.id };
    });
  }
}
