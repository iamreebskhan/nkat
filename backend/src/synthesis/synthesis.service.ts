/**
 * SynthesisService — picks the configured provider per-tenant via
 * `feature_flag` rows and dispatches.
 *
 *   feature_flag.synthesis.enabled  — required true to call out to a provider.
 *   feature_flag.synthesis.provider — config blob {name: 'deterministic'|'bedrock'}.
 *
 * If the flag is disabled the service throws SynthesisRefusedError so the
 * caller can fall back to rendering structured findings only.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import { runWithTenant } from '../database/rls-transaction';
import type { Database } from '../database/schema.types';
import { FeatureFlagService } from '../feature-flags/feature-flag.service';
import { MetricsService } from '../observability/metrics.service';
import { BedrockSynthesisProvider } from './bedrock-provider';
import { CacheVersionService } from './cache-version.service';
import { DeterministicSynthesisProvider } from './deterministic-provider';
import { contentHashFor } from './synthesis-cache-pure';
import {
  SynthesisRefusedError,
  type SynthesisProvider,
  type SynthesisRequest,
  type SynthesisResult,
} from './synthesis-types';

export const SYNTHESIS_FLAG_ENABLED = 'synthesis.enabled';
export const SYNTHESIS_FLAG_PROVIDER = 'synthesis.provider';

@Injectable()
export class SynthesisService {
  private readonly log = new Logger(SynthesisService.name);
  constructor(
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
    @Inject(DeterministicSynthesisProvider) private readonly deterministic: DeterministicSynthesisProvider,
    /** Optional — only present when AWS Bedrock is wired in production. */
    @Optional() @Inject(BedrockSynthesisProvider) private readonly bedrock?: BedrockSynthesisProvider,
    /**
     * Optional — when wired, identical re-renders return cached results
     * within the 7-day TTL. When unset, every call hits the provider.
     */
    @Optional() @Inject(DB_TOKEN) private readonly db?: Kysely<Database>,
    /** Optional — when wired, hash includes a global cache version that admins bump on rule changes. */
    @Optional() @Inject(CacheVersionService) private readonly cacheVersion?: CacheVersionService,
    /** Optional — observability hook. Tests + dev pass nothing. */
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  async synthesize(orgId: string, req: SynthesisRequest): Promise<SynthesisResult> {
    const enabled = await this.flags.isEnabled(SYNTHESIS_FLAG_ENABLED, orgId);
    if (!enabled) {
      throw new SynthesisRefusedError('flag_disabled', 'synthesis.enabled is off for this tenant');
    }
    const provider = await this.pickProvider(orgId);
    const cacheV = this.cacheVersion ? await this.cacheVersion.current() : 1;
    const hash = contentHashFor(provider.name, req, cacheV);

    // 1. Cache lookup. Best-effort — failures never block synthesis.
    if (this.db) {
      try {
        const hit = await this.lookupCache(orgId, hash);
        if (hit) {
          this.log.log(`synthesis cache HIT org=${orgId} provider=${provider.name}`);
          this.metrics?.increment('billing_rules.synthesis.cache_hit', 1, {
            provider: provider.name,
          });
          return hit;
        }
      } catch (e) {
        this.log.warn(
          `synthesis cache lookup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.metrics?.increment('billing_rules.synthesis.cache_miss', 1, {
      provider: provider.name,
    });

    // 2. Provider call.
    const t0 = Date.now();
    const result = await provider.synthesize(req);
    this.metrics?.timing('billing_rules.synthesis.provider_ms', Date.now() - t0, {
      provider: provider.name,
    });
    if (typeof (result as unknown as { cost_usd?: number }).cost_usd === 'number') {
      const cost = (result as unknown as { cost_usd: number }).cost_usd;
      this.metrics?.increment('billing_rules.synthesis.cost_usd', cost, {
        provider: provider.name,
      });
    }

    // 3. Cache store. Best-effort.
    if (this.db && !result.hallucination_risk) {
      // Don't cache hallucination-risk results — they're advisory and
      // we want the next render to attempt fresh.
      try {
        await this.storeCache(orgId, hash, provider.name, result);
      } catch (e) {
        this.log.warn(
          `synthesis cache store failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return result;
  }

  private async lookupCache(orgId: string, hash: string): Promise<SynthesisResult | null> {
    if (!this.db) return null;
    return runWithTenant(this.db, orgId, async (tx) => {
      const row = await tx
        .selectFrom('synthesis_cache')
        .select(['result', 'expires_at'])
        .where('org_id', '=', orgId)
        .where('content_hash', '=', hash)
        .executeTakeFirst();
      if (!row) return null;
      if (row.expires_at.getTime() <= Date.now()) return null;
      // Bump hit-count + last_hit_at — best-effort, don't block on it.
      await tx
        .updateTable('synthesis_cache')
        .set({
          hit_count: sql<number>`hit_count + 1`,
          last_hit_at: sql<Date>`now()`,
        })
        .where('org_id', '=', orgId)
        .where('content_hash', '=', hash)
        .execute();
      return row.result as unknown as SynthesisResult;
    });
  }

  private async storeCache(
    orgId: string,
    hash: string,
    provider: string,
    result: SynthesisResult,
  ): Promise<void> {
    if (!this.db) return;
    await runWithTenant(this.db, orgId, async (tx) => {
      await tx
        .insertInto('synthesis_cache')
        .values({
          org_id: orgId,
          content_hash: hash,
          result: result as unknown as Record<string, unknown>,
          provider,
        })
        .onConflict((oc) =>
          // Replace the cached row on conflict — preserves hit_count + last_hit_at.
          oc.columns(['org_id', 'content_hash']).doUpdateSet({
            result: result as unknown as Record<string, unknown>,
            provider,
            expires_at: sql<Date>`now() + interval '7 days'`,
          }),
        )
        .execute();
    });
  }

  /** Visible for tests so we can assert which provider was selected. */
  async pickProvider(orgId: string): Promise<SynthesisProvider> {
    const cfg = await this.flags.getConfig<{ name?: string }>(SYNTHESIS_FLAG_PROVIDER, orgId);
    const name = (cfg.name ?? 'deterministic').toLowerCase();
    if (name === 'bedrock') {
      if (!this.bedrock) {
        // Production wiring missing → fall back rather than throwing.
        return this.deterministic;
      }
      return this.bedrock;
    }
    return this.deterministic;
  }
}
