/**
 * Error reporter — Sentry-style interface that's vendor-agnostic.
 *
 * The application calls `ErrorReporter.capture(...)` on unexpected
 * exceptions. The provider (Sentry, Bugsnag, Datadog Error Tracking,
 * a no-op for tests) is bound at module init.
 *
 * The default implementation here uses Datadog Error Tracking via
 * the Datadog Agent when `DD_AGENT_HOST` is set: errors are emitted
 * as a structured log line that the Agent forwards. Falls back to
 * console.error otherwise.
 *
 * Why not a hard dependency on `@sentry/node`: the platform already
 * uses Datadog for metrics; pulling Sentry in would mean a second
 * SDK + a second token. If the operator wants Sentry instead, they
 * swap the provider in ErrorReporterModule.
 */
import { Injectable, Logger } from '@nestjs/common';

export interface ErrorEvent {
  error: Error | unknown;
  /** Optional: opaque context to send alongside (request id, user, tenant). */
  context?: Record<string, unknown>;
  /** Severity. Defaults to 'error'. */
  severity?: 'fatal' | 'error' | 'warning' | 'info';
  /** Optional fingerprint to group related events; otherwise the error
   *  class + message is used by the upstream service. */
  fingerprint?: string[];
}

export interface IErrorReporter {
  capture(event: ErrorEvent): void;
  /** Flush any in-flight buffered events. Called on graceful shutdown. */
  flush(timeoutMs?: number): Promise<void>;
}

/**
 * Datadog Agent + structured-log error reporter. Emits a log line
 * the Agent picks up via its log pipeline. Tagged so it lands in
 * "Error Tracking" in the Datadog UI.
 */
@Injectable()
export class DatadogErrorReporter implements IErrorReporter {
  private readonly log = new Logger('ErrorReporter');

  capture(event: ErrorEvent): void {
    const err = event.error;
    const isErr = err instanceof Error;
    const payload = {
      severity: event.severity ?? 'error',
      'error.kind': isErr ? err.constructor.name : typeof err,
      'error.message': isErr ? err.message : String(err),
      'error.stack': isErr ? err.stack ?? '' : '',
      'dd.fingerprint': event.fingerprint?.join('|'),
      context: event.context,
    };
    // Datadog's log scraper auto-routes this to Error Tracking when
    // severity is 'error' or 'fatal'.
    this.log.error(JSON.stringify(payload));
  }

  async flush(_timeoutMs = 2000): Promise<void> {
    // Stdout/stderr are line-buffered; nothing to flush in this provider.
    return;
  }
}

/** No-op for tests + dev. */
export class NoopErrorReporter implements IErrorReporter {
  capture(): void {}
  async flush(): Promise<void> {}
}
