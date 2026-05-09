/**
 * Nest interceptor that implements the Stripe-style `Idempotency-Key`
 * pattern for any handler decorated with `@Idempotent()`.
 *
 *   1. If the request has no `Idempotency-Key` header, pass through.
 *      The endpoint behaves normally — idempotency is opt-in per request.
 *
 *   2. If the key is present:
 *      a. Validate the key format (8..255 ASCII printable, no spaces).
 *      b. Compute SHA-256 of (method, path, canonical body).
 *      c. SELECT existing row.
 *         - cached + hash matches → replay the cached status + body.
 *         - cached + hash differs → 422 IDEMPOTENCY_KEY_REUSED.
 *         - miss → execute handler, then INSERT the response.
 *
 *   3. The cached response is replayed via res.status(...).send(...) so
 *      Nest's response pipeline doesn't re-process it (avoids accidental
 *      header / interceptor double-application on the replay).
 */
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, of, tap } from 'rxjs';
import { hashRequest, isValidKey } from './idempotency-pure';
import { IdempotencyService } from './idempotency.service';

export const IDEMPOTENT_KEY = 'idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly log = new Logger(IdempotencyInterceptor.name);
  constructor(
    private readonly reflector: Reflector,
    private readonly service: IdempotencyService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!isIdempotent) return next.handle();

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const rawKey = (req.headers['idempotency-key'] ?? req.headers['Idempotency-Key']) as
      | string
      | undefined;
    if (!rawKey) {
      // Header absent → behave as if @Idempotent() weren't applied.
      return next.handle();
    }
    if (!isValidKey(rawKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_INVALID' });
    }

    const orgId = (req as Request & { auth?: { orgId?: string } }).auth?.orgId;
    if (!orgId) {
      // Without auth context, we have no tenant to scope the key under.
      // Treat as if header weren't present.
      return next.handle();
    }

    const requestHash = hashRequest({
      method: req.method ?? 'POST',
      path: req.originalUrl ?? req.url ?? '',
      body: (req as Request & { body?: unknown }).body ?? {},
    });

    const lookup = await this.service.findExisting(orgId, rawKey, requestHash);
    if (lookup.kind === 'cached') {
      // Replay the cached response without re-running the handler chain.
      res.setHeader('idempotency-replayed', 'true');
      res.status(lookup.status).send(lookup.body);
      // Returning an EMPTY observable would still let Nest serialize a
      // body. Returning an observable of the cached body matches the
      // happy-path shape AND is what Nest pipes to res. But we already
      // wrote the response. Returning `of(undefined)` short-circuits
      // Nest's serializer when res.headersSent is true.
      return of(undefined);
    }
    if (lookup.kind === 'conflict') {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
    }

    return next.handle().pipe(
      tap({
        next: async (resBody) => {
          // Capture the status code from the response. Nest sets it
          // before tap fires when the handler resolves successfully.
          const status = res.statusCode || 200;
          if (status >= 500) {
            // Don't cache 5xx — retries should re-run, not replay.
            return;
          }
          try {
            const body = (
              typeof resBody === 'object' && resBody !== null
                ? (resBody as Record<string, unknown>)
                : { value: resBody }
            ) as Record<string, unknown>;
            await this.service.store(orgId, rawKey, requestHash, status, body);
          } catch (e) {
            this.log.warn(
              `idempotency store failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
        // We don't cache failed responses (errors) — Nest will throw
        // and the controller's exception filter formats the body.
      }),
    );
  }
}
