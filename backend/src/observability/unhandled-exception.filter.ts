/**
 * Catches every unhandled exception in the request pipeline and:
 *
 *   1. Forwards it to the configured `ErrorReporter` so the operator
 *      sees it in Datadog Error Tracking (or whatever provider is wired).
 *   2. Returns a clean JSON 5xx to the client — no stack trace leaked.
 *
 * Nest already handles `HttpException` (400/404/etc.) gracefully — those
 * pass through unchanged. This filter only fires up the reporter for
 * non-HttpException errors (real bugs) AND for HttpException with status
 * ≥ 500 (programmer-error 5xx, distinct from the explicit ones we throw).
 *
 * Wired via `APP_FILTER` in ObservabilityModule so it covers every route
 * including ones in modules registered after the filter.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ERROR_REPORTER_TOKEN } from './observability.module';
import type { IErrorReporter } from './error-reporter';
import { MetricsService } from './metrics.service';

@Catch()
export class UnhandledExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(UnhandledExceptionFilter.name);

  constructor(
    @Optional() @Inject(ERROR_REPORTER_TOKEN) private readonly reporter?: IErrorReporter,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttpException = err instanceof HttpException;
    const status = isHttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const isServerError = status >= 500;

    // Report to the error tracker for real bugs only — 4xx are the
    // request validator doing its job and shouldn't page anyone.
    if (!isHttpException || isServerError) {
      this.reporter?.capture({
        error: err,
        severity: isServerError ? 'error' : 'warning',
        context: {
          path: req.path,
          method: req.method,
          orgId: (req as Request & { auth?: { orgId?: string } }).auth?.orgId,
          userId: (req as Request & { auth?: { userId?: string } }).auth?.userId,
          query: req.query,
        },
      });
      this.metrics?.increment('billing_rules.unhandled_exception', 1, {
        path: req.route?.path ?? req.path,
        method: req.method,
        status: String(status),
      });
      this.log.error(
        `${req.method} ${req.path} → ${status} ${(err as Error)?.message ?? String(err)}`,
        (err as Error)?.stack,
      );
    }

    // Build the response body. For HttpException we honor whatever
    // payload was attached (BadRequestException({code, detail, ...})
    // shape we use everywhere). For real exceptions we redact.
    const body = isHttpException
      ? toBody(err.getResponse(), status)
      : { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };

    if (!res.headersSent) {
      res.status(status).json(body);
    }
  }
}

function toBody(payload: unknown, status: number): Record<string, unknown> {
  if (typeof payload === 'string') {
    return { code: defaultCodeForStatus(status), message: payload };
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.code === 'string') return obj;
    return { code: defaultCodeForStatus(status), ...obj };
  }
  return { code: defaultCodeForStatus(status) };
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE';
    case 429:
      return 'RATE_LIMITED';
    case 500:
      return 'INTERNAL_ERROR';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return `HTTP_${status}`;
  }
}
