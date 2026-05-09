/**
 * WebhookService — enqueue + deliver outbound webhook events.
 *
 *   - `enqueue()` writes a `webhook_delivery` row per active subscription that
 *     subscribes to the given event_type.
 *   - `runDeliveryBatch()` picks up to N rows whose `ready_at <= now` and
 *     attempts HTTP POSTs. Exponential backoff on failure; dead-letter after
 *     `max_attempts`.
 *
 * Caller chooses whether to run delivery in-process or via a separate worker.
 * Either way, RLS scopes everything to the subscription's org.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runWithTenant, type Tx } from '../database/rls-transaction';
import type { WebhookEventType } from '../database/schema.types';
import { canonicalJson, signPayload } from './signing';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EnqueueInput {
  org_id: string;
  event_type: WebhookEventType;
  event_id: string;
  payload: Record<string, unknown>;
}

export interface DeliveryResult {
  delivery_id: string;
  status_code?: number;
  succeeded: boolean;
  error?: string;
  next_status: 'succeeded' | 'queued' | 'dead_letter';
}

const BACKOFF_SEQUENCE_MS = [
  0, // attempt 1: immediate
  60_000, // attempt 2: +1m
  300_000, // attempt 3: +5m
  900_000, // attempt 4: +15m
  3_600_000, // attempt 5: +1h
  21_600_000, // attempt 6: +6h
  86_400_000, // attempt 7: +24h
  86_400_000, // attempt 8: +24h
];

function nextReadyAt(attempt: number, now: Date): Date | null {
  const idx = Math.min(attempt, BACKOFF_SEQUENCE_MS.length - 1);
  const ms = BACKOFF_SEQUENCE_MS[idx];
  return new Date(now.getTime() + ms);
}

@Injectable()
export class WebhookService {
  private readonly log = new Logger(WebhookService.name);
  private readonly fetchImpl: FetchLike;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Optional() fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async enqueue(input: EnqueueInput): Promise<{ enqueued: number }> {
    return runWithTenant(this.db, input.org_id, async (tx) => {
      const subs = await tx
        .selectFrom('webhook_subscription')
        .select(['id', 'signing_secret'])
        .where('status', '=', 'active')
        .where('event_types', '@>', [input.event_type])
        .execute();

      const now = new Date();
      let enqueued = 0;
      for (const s of subs) {
        const signed = signPayload(
          s.signing_secret,
          {
            event: input.event_type,
            event_id: input.event_id,
            org_id: input.org_id,
            data: input.payload,
          },
          now.getTime(),
        );
        await tx
          .insertInto('webhook_delivery')
          .values({
            org_id: input.org_id,
            subscription_id: s.id,
            event_id: input.event_id,
            event_type: input.event_type,
            payload: {
              event: input.event_type,
              event_id: input.event_id,
              org_id: input.org_id,
              data: input.payload,
            },
            signature: signed.signature,
            ready_at: now,
          })
          .execute();
        enqueued++;
      }
      return { enqueued };
    });
  }

  async runDeliveryBatch(orgId: string, limit = 25): Promise<DeliveryResult[]> {
    return runWithTenant(this.db, orgId, async (tx) => {
      const now = new Date();
      // Atomic claim: SELECT FOR UPDATE SKIP LOCKED + UPDATE in one statement.
      const claimed = await sql<{
        id: string;
        subscription_id: string;
        payload: Record<string, unknown>;
        signature: string;
        attempt_count: number;
        max_attempts: number;
        url: string;
        signing_secret: string;
      }>`
        WITH next_batch AS (
          SELECT wd.id
          FROM webhook_delivery wd
          WHERE wd.org_id = app.current_org_id()
            AND wd.status IN ('queued', 'in_flight')
            AND wd.ready_at IS NOT NULL
            AND wd.ready_at <= ${now}
          ORDER BY wd.ready_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE webhook_delivery wd
           SET status = 'in_flight', last_attempt_at = ${now}
          FROM next_batch nb
          JOIN webhook_subscription ws ON ws.id = wd.subscription_id
         WHERE wd.id = nb.id
        RETURNING wd.id, wd.subscription_id, wd.payload, wd.signature,
                  wd.attempt_count, wd.max_attempts, ws.url, ws.signing_secret
      `.execute(tx);

      const results: DeliveryResult[] = [];
      for (const row of claimed.rows) {
        const result = await this.deliverOne(tx, row, now);
        results.push(result);
      }
      return results;
    });
  }

  private async deliverOne(
    tx: Tx,
    row: {
      id: string;
      subscription_id: string;
      payload: Record<string, unknown>;
      signature: string;
      attempt_count: number;
      max_attempts: number;
      url: string;
    },
    now: Date,
  ): Promise<DeliveryResult> {
    const body = canonicalJson(row.payload);
    const newAttempt = row.attempt_count + 1;
    let statusCode: number | undefined;
    let error: string | undefined;
    let succeeded = false;
    try {
      const res = await this.fetchImpl(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': row.signature,
          'X-Event-Type': String(row.payload.event ?? ''),
          'X-Webhook-Attempt': String(newAttempt),
        },
        body,
      });
      statusCode = res.status;
      succeeded = res.status >= 200 && res.status < 300;
      if (!succeeded) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message;
      this.log.warn(`webhook delivery ${row.id} attempt ${newAttempt}: ${error}`);
    }

    let nextStatus: 'succeeded' | 'queued' | 'dead_letter';
    let nextReady: Date | null;
    if (succeeded) {
      nextStatus = 'succeeded';
      nextReady = null;
    } else if (newAttempt >= row.max_attempts) {
      nextStatus = 'dead_letter';
      nextReady = null;
    } else {
      nextStatus = 'queued';
      nextReady = nextReadyAt(newAttempt, now);
    }

    await tx
      .updateTable('webhook_delivery')
      .set({
        status: nextStatus,
        attempt_count: newAttempt,
        last_attempt_at: now,
        last_status_code: statusCode ?? null,
        last_error: error ?? null,
        ready_at: nextReady,
      })
      .where('id', '=', row.id)
      .execute();

    if (succeeded) {
      await tx
        .updateTable('webhook_subscription')
        .set({ last_success_at: now, consecutive_failures: 0 })
        .where('id', '=', row.subscription_id)
        .execute();
    } else {
      await tx
        .updateTable('webhook_subscription')
        .set({
          last_failure_at: now,
          consecutive_failures: sql`consecutive_failures + 1`,
        })
        .where('id', '=', row.subscription_id)
        .execute();
    }

    return {
      delivery_id: row.id,
      ...(statusCode !== undefined ? { status_code: statusCode } : {}),
      succeeded,
      ...(error ? { error } : {}),
      next_status: nextStatus,
    };
  }
}

/** Visible for unit tests of backoff schedule. */
export const _backoffForTesting = { nextReadyAt, BACKOFF_SEQUENCE_MS };
