/**
 * ReconciliationService — orchestrates Job 2 (rule reconciliation):
 *
 *   1. createRulebook() opens a draft client_rulebook for a client.
 *   2. computeDiff() loads client_rule rows for the rulebook + the corresponding
 *      payer_rule rows from the same (payer, state, product_line, code, attribute,
 *      DOS=today) and runs the pure diff-engine.
 *   3. decide() records a per-row decision (accept_authoritative | keep_client |
 *      edit_custom | intentional_deviation) on a client_rule row.
 *   4. finalize() computes integrity_hash + locks the rulebook to status='finalized'.
 *
 * All multi-statement work runs through `runWithTenant` so RLS enforces the
 * org boundary.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant, type Tx } from '../database/rls-transaction';
import { computeDiff, type DiffSet, type RuleSnapshot } from './diff-engine';
import type { CoverageStatus } from '../database/schema.types';

export class RulebookNotFoundError extends Error {
  constructor(id: string) {
    super(`Rulebook ${id} not found in this tenant`);
    this.name = 'RulebookNotFoundError';
  }
}

export class RulebookNotEditableError extends Error {
  constructor(id: string, status: string) {
    super(`Rulebook ${id} is in status '${status}'; cannot modify`);
    this.name = 'RulebookNotEditableError';
  }
}

@Injectable()
export class ReconciliationService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async createRulebook(orgId: string, clientId: string, notes?: string): Promise<{ id: string; version: number }> {
    return runWithTenant(this.db, orgId, async (tx) => {
      const lastVersion = await tx
        .selectFrom('client_rulebook')
        .select(({ fn }) => [fn.max('version').as('max_version')])
        .where('client_id', '=', clientId)
        .executeTakeFirst();
      const next = ((lastVersion?.max_version as number | null) ?? 0) + 1;

      const inserted = await tx
        .insertInto('client_rulebook')
        .values({
          org_id: orgId,
          client_id: clientId,
          version: next,
          status: 'draft',
          source_doc_ids: [],
          notes: notes ?? null,
        })
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow();
      return { id: inserted.id, version: inserted.version };
    });
  }

  async computeDiff(orgId: string, rulebookId: string): Promise<DiffSet> {
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rulebook = await this.loadRulebook(tx, rulebookId);
      const clientRows = await tx
        .selectFrom('client_rule')
        .select(['id', 'payer_id', 'state', 'product_line', 'code', 'attribute', 'value'])
        .where('rulebook_id', '=', rulebookId)
        .execute();

      const clientSnapshots: RuleSnapshot[] = clientRows.map((r) => ({
        payer_id: r.payer_id,
        state: r.state,
        product_line: r.product_line,
        code: r.code,
        attribute: r.attribute,
        value: r.value,
        coverage_status: ((r.value as { coverage_status?: CoverageStatus }).coverage_status ?? 'covered'),
        effective_date: rulebook.created_at.toISOString().slice(0, 10),
        source_id: r.id,
      }));

      // Pull authoritative rows for the same code/attribute set, effective today.
      const today = new Date();
      const rules = await tx
        .selectFrom('payer_rule')
        .select(['id', 'payer_id', 'state', 'product_line', 'code', 'attribute', 'value', 'coverage_status', 'effective_date'])
        .where('effective_date', '<=', today)
        .where((eb) => eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', today)]))
        // bound the working set: only fetch keys present in client OR for codes the client used
        .where((eb) => {
          const codes = Array.from(new Set(clientRows.map((r) => r.code)));
          return codes.length > 0 ? eb('code', 'in', codes) : eb.lit(false);
        })
        .execute();

      const authSnapshots: RuleSnapshot[] = rules.map((r) => ({
        payer_id: r.payer_id,
        state: r.state,
        product_line: r.product_line,
        code: r.code,
        attribute: r.attribute,
        value: r.value,
        coverage_status: r.coverage_status,
        effective_date: r.effective_date.toISOString().slice(0, 10),
        source_id: r.id,
      }));

      return computeDiff(authSnapshots, clientSnapshots);
    });
  }

  async decide(orgId: string, clientRuleId: string, decision: 'accept_authoritative' | 'keep_client' | 'edit_custom' | 'intentional_deviation', note: string | null, decidedBy: string): Promise<void> {
    await runWithTenant(this.db, orgId, async (tx) => {
      await tx
        .updateTable('client_rule')
        .set({ decision, decision_note: note, decided_by: decidedBy, decided_at: new Date() })
        .where('id', '=', clientRuleId)
        .execute();
    });
  }

  async finalize(orgId: string, rulebookId: string, finalizedBy: string): Promise<{ integrity_hash: string }> {
    return runWithTenant(this.db, orgId, async (tx) => {
      const rulebook = await this.loadRulebook(tx, rulebookId);
      if (rulebook.status === 'finalized') {
        throw new RulebookNotEditableError(rulebookId, rulebook.status);
      }

      // Compute a fresh diff for the integrity hash. Note: this is the
      // hash-as-of-finalization; subsequent authoritative drift is captured
      // by the alerting subsystem.
      const diff = await this.computeDiff(orgId, rulebookId);

      // Stable sha256 over a canonical JSON of the diff entries so we can
      // verify integrity later (e.g. customer asks "did anything change since
      // I finalized?").
      const sha = createHash('sha256')
        .update(
          JSON.stringify({
            rulebook_id: rulebookId,
            entries: diff.entries.map((e) => ({
              outcome: e.outcome,
              key: e.key,
              ...(e.field_diffs ? { field_diffs: e.field_diffs } : {}),
            })),
          }),
        )
        .digest('hex');

      await tx
        .updateTable('client_rulebook')
        .set({
          status: 'finalized',
          finalized_at: new Date(),
          finalized_by: finalizedBy,
          integrity_hash: sha,
        })
        .where('id', '=', rulebookId)
        .execute();

      return { integrity_hash: sha };
    });
  }

  // -------- internals --------

  private async loadRulebook(tx: Tx, rulebookId: string): Promise<{ id: string; status: string; created_at: Date }> {
    const r = await tx
      .selectFrom('client_rulebook')
      .select(['id', 'status', 'created_at'])
      .where('id', '=', rulebookId)
      .executeTakeFirst();
    if (!r) throw new RulebookNotFoundError(rulebookId);
    return r;
  }

  // expose the kysely raw `sql` for the caller's convenience in tests
  static get sqlTag() {
    return sql;
  }
}
