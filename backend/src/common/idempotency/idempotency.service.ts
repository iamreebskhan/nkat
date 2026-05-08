/**
 * IdempotencyService — read/write the cached response for an
 * (org_id, key) pair. The interceptor calls these in order:
 *
 *   findExisting(orgId, key, requestHash)
 *      → { cached: { status, body } }   if found, hash matches
 *      → { conflict: true }              if found, hash differs (Stripe-style 422)
 *      → { miss: true }                  if not found
 *
 *   store(orgId, key, requestHash, status, body)
 *      Persists the response. On PK conflict (race-loser), re-reads the
 *      winner's row + returns its response — so concurrent retries
 *      always see a single canonical response.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { runWithTenant } from '../../database/rls-transaction';
import type { Database } from '../../database/schema.types';

export type FindResult =
  | { kind: 'cached'; status: number; body: Record<string, unknown> }
  | { kind: 'conflict' }
  | { kind: 'miss' };

@Injectable()
export class IdempotencyService {
  private readonly log = new Logger(IdempotencyService.name);
  constructor(private readonly db: Kysely<Database>) {}

  async findExisting(orgId: string, key: string, requestHash: string): Promise<FindResult> {
    return runWithTenant(this.db, orgId, async (tx) => {
      const row = await tx
        .selectFrom('idempotency_record')
        .select(['request_hash', 'response_status', 'response_body', 'expires_at'])
        .where('org_id', '=', orgId)
        .where('key', '=', key)
        .executeTakeFirst();
      if (!row) return { kind: 'miss' as const };
      if (row.expires_at.getTime() <= Date.now()) {
        // Stale row — treat as miss; the cleanup cron reclaims later.
        return { kind: 'miss' as const };
      }
      if (row.request_hash !== requestHash) {
        return { kind: 'conflict' as const };
      }
      return {
        kind: 'cached' as const,
        status: row.response_status,
        body: row.response_body,
      };
    });
  }

  async store(
    orgId: string,
    key: string,
    requestHash: string,
    status: number,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return runWithTenant(this.db, orgId, async (tx) => {
      try {
        await tx
          .insertInto('idempotency_record')
          .values({
            org_id: orgId,
            key,
            request_hash: requestHash,
            response_status: status,
            response_body: body,
          })
          .execute();
        return { status, body };
      } catch (e) {
        // Race-lost on (org_id, key) PK. Re-read the winner's row.
        if (!(e instanceof Error) || !/duplicate|unique/i.test(e.message)) {
          throw e;
        }
        const winner = await tx
          .selectFrom('idempotency_record')
          .select(['request_hash', 'response_status', 'response_body'])
          .where('org_id', '=', orgId)
          .where('key', '=', key)
          .executeTakeFirstOrThrow();
        if (winner.request_hash !== requestHash) {
          // We finished work, but the winning request had different
          // body — surface as conflict to the caller. The work we did
          // is wasted; the winner's response is what the client gets.
          this.log.warn(`idempotency race produced conflict org=${orgId} key=${key}`);
        }
        return { status: winner.response_status, body: winner.response_body };
      }
    });
  }
}
