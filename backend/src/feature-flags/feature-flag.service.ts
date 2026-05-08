/**
 * FeatureFlagService — global + per-tenant flags backed by `feature_flag`.
 *
 *   isEnabled(flag, orgId?)  — tenant override wins; else global default; else false.
 *   getConfig(flag, orgId?)  — same precedence; returns the JSONB config blob.
 *   setFlag(flag, orgId?, enabled, config?, rationale?) — upsert.
 *
 * No RLS on the table itself (it's global); the service still requires an
 * orgId for tenant-scoped operations and records audit-relevant fields.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

export interface FlagState {
  flag_key: string;
  enabled: boolean;
  config: Record<string, unknown>;
  origin: 'tenant' | 'global' | 'default';
}

@Injectable()
export class FeatureFlagService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async resolve(flagKey: string, orgId: string | null = null): Promise<FlagState> {
    if (orgId) {
      const tenantRow = await this.db
        .selectFrom('feature_flag')
        .select(['enabled', 'config'])
        .where('flag_key', '=', flagKey)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (tenantRow) {
        return {
          flag_key: flagKey,
          enabled: tenantRow.enabled,
          config: tenantRow.config,
          origin: 'tenant',
        };
      }
    }
    const globalRow = await this.db
      .selectFrom('feature_flag')
      .select(['enabled', 'config'])
      .where('flag_key', '=', flagKey)
      .where('org_id', 'is', null)
      .executeTakeFirst();
    if (globalRow) {
      return {
        flag_key: flagKey,
        enabled: globalRow.enabled,
        config: globalRow.config,
        origin: 'global',
      };
    }
    return { flag_key: flagKey, enabled: false, config: {}, origin: 'default' };
  }

  async isEnabled(flagKey: string, orgId: string | null = null): Promise<boolean> {
    return (await this.resolve(flagKey, orgId)).enabled;
  }

  async getConfig<T = Record<string, unknown>>(
    flagKey: string,
    orgId: string | null = null,
  ): Promise<T> {
    return (await this.resolve(flagKey, orgId)).config as T;
  }

  async setFlag(
    flagKey: string,
    orgId: string | null,
    enabled: boolean,
    config: Record<string, unknown> = {},
    rationale?: string,
  ): Promise<void> {
    await this.db
      .insertInto('feature_flag')
      .values({
        flag_key: flagKey,
        org_id: orgId,
        enabled,
        config: sql`${JSON.stringify(config)}::jsonb`,
        rationale: rationale ?? null,
      })
      .onConflict((oc) =>
        oc.constraint('feature_flag_pkey').doUpdateSet({
          enabled: sql.ref('excluded.enabled'),
          config: sql.ref('excluded.config'),
          rationale: sql.ref('excluded.rationale'),
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }
}
