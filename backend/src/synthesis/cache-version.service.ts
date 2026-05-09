/**
 * Reads the global `synthesis_cache.version` from `system_setting`,
 * with an in-process TTL cache so we don't query Postgres on every
 * synthesis call.
 *
 *   - TTL = 60s. After an invalidation bump, stale cache hits for up
 *     to ~60s while every API task ages out. Acceptable: the cache is
 *     a cost-saver, not a correctness boundary.
 *
 *   - Bump path goes straight to the DB and invalidates this instance's
 *     in-process cache immediately (so the bumping caller sees its own
 *     bump on the next call). Other API tasks pick up via TTL.
 *
 *   - Reading a missing row returns version 1 (matches the migration
 *     seed) — a fresh deploy without the seed doesn't crash hash path.
 *
 * Storage format: `value JSONB` is a JSON number (e.g. `1`, `42`). We
 * use `value::int` for atomic increment.
 */
import { Injectable, Logger } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../database/schema.types';

const KEY = 'synthesis_cache.version';
const TTL_MS = 60_000;

@Injectable()
export class CacheVersionService {
  private readonly log = new Logger(CacheVersionService.name);
  private cached: { version: number; expiresAt: number } | null = null;

  constructor(private readonly db: Kysely<Database>) {}

  async current(nowMs: number = Date.now()): Promise<number> {
    if (this.cached && this.cached.expiresAt > nowMs) return this.cached.version;
    let version = 1;
    try {
      const r = await sql<{ v: number }>`
        SELECT (value)::int AS v FROM system_setting WHERE key = ${KEY}
      `.execute(this.db);
      const v = Number(r.rows[0]?.v);
      if (Number.isFinite(v) && v >= 1) version = v;
    } catch (e) {
      this.log.warn(
        `cache version read failed; defaulting to 1: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.cached = { version, expiresAt: nowMs + TTL_MS };
    return version;
  }

  /**
   * Atomically increment the cache version. Concurrent bumps each get
   * their own incremental return value (no lost updates) because the
   * UPDATE arithmetic happens server-side.
   */
  async bump(args: { byUserId?: string | null; note?: string | null } = {}): Promise<number> {
    const r = await sql<{ v: number }>`
      INSERT INTO system_setting (key, value, updated_by_user_id, note)
      VALUES (${KEY}, '1'::jsonb, ${args.byUserId ?? null}, ${args.note ?? null})
      ON CONFLICT (key) DO UPDATE SET
        value              = ((system_setting.value::int + 1)::text)::jsonb,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        note               = EXCLUDED.note,
        updated_at         = now()
      RETURNING (value)::int AS v
    `.execute(this.db);
    const v = Number(r.rows[0]?.v ?? 1);
    this.cached = { version: v, expiresAt: Date.now() + TTL_MS };
    this.log.log(
      `cache version bumped to ${v} by ${args.byUserId ?? 'cli'}; note=${args.note ?? '-'}`,
    );
    return v;
  }

  /** Test-only: drop the in-process cache so the next call re-queries. */
  _resetCache(): void {
    this.cached = null;
  }
}
