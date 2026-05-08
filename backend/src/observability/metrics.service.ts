/**
 * Application metrics emitter.
 *
 * Emits to a DogStatsD-compatible UDP endpoint (the Datadog Agent
 * sidecar in our ECS task definition listens on 127.0.0.1:8125 by
 * default). When `DD_AGENT_HOST` is unset (dev / unit tests) the
 * emitter falls back to a no-op so production code can call
 * `metrics.increment(...)` without env-coupling.
 *
 * Hand-rolled rather than the `hot-shots` SDK so we don't pull in a
 * dependency for what is ~80 lines of UDP-write logic. Format spec:
 *   <metric>:<value>|<type>|#<tag1>,<tag2>=<v>
 *
 * Metric names referenced by Datadog dashboards (Phase 37):
 *   - billing_rules.synthesis.cache_hit / cache_miss      (counter)
 *   - billing_rules.synthesis.cost_usd                    (counter, fractional)
 *   - billing_rules.rate_limit.rejected{scope}            (counter)
 *   - billing_rules.auth.jwks_fetch_ms                    (histogram)
 *   - billing_rules.eval.pass / eval.run                  (counter)
 *   - billing_rules.era835.ingest_lag_sec                 (gauge)
 *   - billing_rules.stripe.webhook_secret_index{secret_index}  (counter)
 *   - billing_rules.denial.dollar_impact{carc}            (counter)
 */
import { createSocket, type Socket } from 'node:dgram';
import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from '@nestjs/common';

export interface MetricsConfig {
  host: string;
  port: number;
  /** Static tags attached to every metric (env, service, region). */
  globalTags: string[];
  /** When false, emit() is a no-op. Tests + dev. */
  enabled: boolean;
}

export const METRICS_CONFIG_TOKEN = Symbol('METRICS_CONFIG');

export interface IMetrics {
  increment(name: string, value?: number, tags?: Record<string, string | number>): void;
  gauge(name: string, value: number, tags?: Record<string, string | number>): void;
  histogram(name: string, value: number, tags?: Record<string, string | number>): void;
  timing(name: string, ms: number, tags?: Record<string, string | number>): void;
}

/**
 * Pure-function metric line builder. Exposed for unit tests so we
 * don't have to spin up a UDP listener to validate format.
 */
export function formatMetricLine(
  name: string,
  value: number,
  type: 'c' | 'g' | 'h' | 'ms',
  tags: string[],
): string {
  // DogStatsD wants tags joined by comma after `|#`. Empty tag list
  // omits the trailing `|#`.
  let out = `${name}:${formatValue(value)}|${type}`;
  if (tags.length > 0) out += `|#${tags.join(',')}`;
  return out;
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '0';
  // Integers without trailing .0; otherwise up to 6 decimals.
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/\.?0+$/, '');
}

export function buildTagList(
  global: string[],
  perCall: Record<string, string | number> | undefined,
): string[] {
  const out = [...global];
  if (perCall) {
    for (const [k, v] of Object.entries(perCall)) {
      out.push(`${sanitizeTagPart(k)}:${sanitizeTagPart(String(v))}`);
    }
  }
  return out;
}

/**
 * DogStatsD tags can't contain `|`, `,`, `:` (in the value part of a
 * key:value pair), or whitespace. Replace anything weird with `_`.
 */
export function sanitizeTagPart(s: string): string {
  return s.replace(/[|,\s]/g, '_').slice(0, 200);
}

@Injectable()
export class MetricsService implements IMetrics, OnApplicationShutdown {
  private readonly log = new Logger(MetricsService.name);
  private socket: Socket | null = null;
  private readonly cfg: MetricsConfig;

  constructor(
    @Optional() @Inject(METRICS_CONFIG_TOKEN) cfg?: MetricsConfig,
  ) {
    this.cfg = cfg ?? {
      host: process.env.DD_AGENT_HOST ?? '',
      port: parseInt(process.env.DD_DOGSTATSD_PORT ?? '8125', 10),
      globalTags: buildGlobalTags(),
      enabled: Boolean(process.env.DD_AGENT_HOST),
    };
    if (this.cfg.enabled) {
      this.socket = createSocket('udp4');
      this.socket.on('error', (e) => {
        // UDP errors are logged but shouldn't crash the app — metrics
        // are observability, not the security boundary.
        this.log.warn(`metrics socket error: ${e.message}`);
      });
    }
  }

  increment(name: string, value = 1, tags?: Record<string, string | number>): void {
    this.emit(name, value, 'c', tags);
  }

  gauge(name: string, value: number, tags?: Record<string, string | number>): void {
    this.emit(name, value, 'g', tags);
  }

  histogram(name: string, value: number, tags?: Record<string, string | number>): void {
    this.emit(name, value, 'h', tags);
  }

  timing(name: string, ms: number, tags?: Record<string, string | number>): void {
    this.emit(name, ms, 'ms', tags);
  }

  onApplicationShutdown(): void {
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  private emit(
    name: string,
    value: number,
    type: 'c' | 'g' | 'h' | 'ms',
    tags?: Record<string, string | number>,
  ): void {
    if (!this.cfg.enabled || !this.socket) return;
    const line = formatMetricLine(name, value, type, buildTagList(this.cfg.globalTags, tags));
    const buf = Buffer.from(line, 'utf8');
    this.socket.send(buf, 0, buf.length, this.cfg.port, this.cfg.host, (err) => {
      if (err) this.log.warn(`metrics send failed: ${err.message}`);
    });
  }
}

function buildGlobalTags(): string[] {
  const tags: string[] = ['service:billing-rules-api'];
  if (process.env.NODE_ENV) tags.push(`env:${sanitizeTagPart(process.env.NODE_ENV)}`);
  if (process.env.AWS_REGION) tags.push(`region:${sanitizeTagPart(process.env.AWS_REGION)}`);
  if (process.env.GIT_SHA) tags.push(`version:${sanitizeTagPart(process.env.GIT_SHA)}`);
  return tags;
}

/**
 * No-op implementation for tests + dev when no agent is configured.
 * Useful for code that wants to depend on `IMetrics` directly.
 */
export class NoopMetrics implements IMetrics {
  increment(_name: string, _value?: number, _tags?: Record<string, string | number>): void {}
  gauge(_name: string, _value: number, _tags?: Record<string, string | number>): void {}
  histogram(_name: string, _value: number, _tags?: Record<string, string | number>): void {}
  timing(_name: string, _ms: number, _tags?: Record<string, string | number>): void {}
}
