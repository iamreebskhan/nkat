import { Module, type OnApplicationBootstrap, Logger, Inject, Optional } from '@nestjs/common';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { MetricsService } from '../observability/metrics.service';
import { AuthController } from './auth.controller';
import { AuthGuard, JWKS_CLIENT_TOKEN } from './auth.guard';
import { JwksClient } from './jwks-client';

/**
 * Lifecycle wrapper that pre-warms the JWKS cache on app bootstrap so
 * the first inbound JWT doesn't pay the ~50–200ms IdP fetch latency.
 * Failure here is non-fatal — first request will retry on its own.
 */
class JwksPrewarmer implements OnApplicationBootstrap {
  private readonly log = new Logger(JwksPrewarmer.name);
  constructor(
    @Optional() @Inject(JWKS_CLIENT_TOKEN) private readonly client?: JwksClient,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.client) {
      this.log.log('JWKS client not configured (dev_header mode); skipping prewarm.');
      return;
    }
    if (this.metrics) {
      this.client.setMetricsHook({ timing: (n, ms) => this.metrics!.timing(n, ms) });
    }
    const r = await this.client.prewarm();
    if (!r.ok) {
      this.log.warn(`JWKS prewarm failed: ${r.error}`);
    }
  }
}

@Module({
  providers: [
    AuthGuard,
    {
      provide: JWKS_CLIENT_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env) => (env.JWT_JWKS_URL ? new JwksClient(env.JWT_JWKS_URL) : undefined),
    },
    JwksPrewarmer,
  ],
  controllers: [AuthController],
  exports: [AuthGuard],
})
export class AuthModule {}
