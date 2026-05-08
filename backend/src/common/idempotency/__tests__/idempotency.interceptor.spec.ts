import { ConflictException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { IDEMPOTENT_KEY, IdempotencyInterceptor } from '../idempotency.interceptor';
import type { IdempotencyService } from '../idempotency.service';

const ORG = '11111111-1111-4111-8111-111111111111';

function makeCtx(args: {
  isIdempotent: boolean;
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  body?: unknown;
  orgId?: string | undefined;
  res?: {
    statusCode?: number;
    setHeader: jest.Mock;
    status: jest.Mock;
    send: jest.Mock;
  };
}) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(args.isIdempotent),
  } as unknown as Reflector;

  const res = args.res ?? {
    statusCode: 200,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
  // status(...).send(...) chain
  res.status.mockReturnValue(res);

  const req = {
    headers: args.headers ?? {},
    method: args.method ?? 'POST',
    originalUrl: args.url ?? '/v1/lookup',
    url: args.url ?? '/v1/lookup',
    body: args.body ?? {},
    auth: args.orgId === undefined ? undefined : { orgId: args.orgId },
  };

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as never;

  return { ctx, reflector, req, res };
}

function makeService(impls: Partial<IdempotencyService>): IdempotencyService {
  return impls as unknown as IdempotencyService;
}

describe('IdempotencyInterceptor', () => {
  it('passes through when @Idempotent() is not set', async () => {
    const { ctx, reflector } = makeCtx({ isIdempotent: false });
    const interceptor = new IdempotencyInterceptor(reflector, makeService({}));
    const next = { handle: () => of({ ok: true }) };
    const result = await firstValueFrom(await interceptor.intercept(ctx, next));
    expect(result).toEqual({ ok: true });
  });

  it('passes through when Idempotency-Key header is absent', async () => {
    const { ctx, reflector } = makeCtx({ isIdempotent: true, orgId: ORG });
    const interceptor = new IdempotencyInterceptor(reflector, makeService({}));
    const next = { handle: () => of({ ok: true }) };
    const result = await firstValueFrom(await interceptor.intercept(ctx, next));
    expect(result).toEqual({ ok: true });
  });

  it('rejects malformed key', async () => {
    const { ctx, reflector } = makeCtx({
      isIdempotent: true,
      orgId: ORG,
      headers: { 'idempotency-key': 'short' }, // < 8 chars
    });
    const interceptor = new IdempotencyInterceptor(reflector, makeService({}));
    const next = { handle: () => of({ ok: true }) };
    await expect(interceptor.intercept(ctx, next)).rejects.toBeInstanceOf(ConflictException);
  });

  it('replays cached response on hash match', async () => {
    const { ctx, reflector, res } = makeCtx({
      isIdempotent: true,
      orgId: ORG,
      headers: { 'idempotency-key': 'replay-key-1234' },
    });
    const svc = makeService({
      findExisting: jest.fn().mockResolvedValue({
        kind: 'cached',
        status: 200,
        body: { from: 'cache' },
      }),
    });
    const interceptor = new IdempotencyInterceptor(reflector, svc);
    const next = { handle: () => of({ from: 'fresh' }) };
    await firstValueFrom(await interceptor.intercept(ctx, next));
    expect(res.setHeader).toHaveBeenCalledWith('idempotency-replayed', 'true');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ from: 'cache' });
  });

  it('throws 422 IDEMPOTENCY_KEY_REUSED on conflict', async () => {
    const { ctx, reflector } = makeCtx({
      isIdempotent: true,
      orgId: ORG,
      headers: { 'idempotency-key': 'conflict-key-1234' },
    });
    const svc = makeService({
      findExisting: jest.fn().mockResolvedValue({ kind: 'conflict' }),
    });
    const interceptor = new IdempotencyInterceptor(reflector, svc);
    const next = { handle: () => of({ ok: true }) };
    await expect(interceptor.intercept(ctx, next)).rejects.toBeInstanceOf(ConflictException);
  });

  it('on miss, executes handler + stores response', async () => {
    const store = jest.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    const { ctx, reflector } = makeCtx({
      isIdempotent: true,
      orgId: ORG,
      headers: { 'idempotency-key': 'miss-key-12345' },
    });
    const svc = makeService({
      findExisting: jest.fn().mockResolvedValue({ kind: 'miss' }),
      store,
    });
    const interceptor = new IdempotencyInterceptor(reflector, svc);
    const next = { handle: () => of({ ok: true }) };
    const result = await firstValueFrom(await interceptor.intercept(ctx, next));
    expect(result).toEqual({ ok: true });
    // tap fires after subscribe — give microtasks a tick.
    await new Promise((r) => setImmediate(r));
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0]).toEqual(
      expect.arrayContaining([ORG, 'miss-key-12345', expect.any(String), 200, { ok: true }]),
    );
  });

  it('skips caching 5xx responses', async () => {
    const store = jest.fn();
    const { ctx, reflector, res } = makeCtx({
      isIdempotent: true,
      orgId: ORG,
      headers: { 'idempotency-key': '5xx-key-12345xx' },
      res: {
        statusCode: 503,
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      },
    });
    res.status.mockReturnValue(res);
    const svc = makeService({
      findExisting: jest.fn().mockResolvedValue({ kind: 'miss' }),
      store,
    });
    const interceptor = new IdempotencyInterceptor(reflector, svc);
    const next = { handle: () => of({ error: 'unavailable' }) };
    await firstValueFrom(await interceptor.intercept(ctx, next));
    await new Promise((r) => setImmediate(r));
    expect(store).not.toHaveBeenCalled();
  });

  it('skips when no orgId on request (degraded mode)', async () => {
    const { ctx, reflector } = makeCtx({
      isIdempotent: true,
      orgId: undefined,
      headers: { 'idempotency-key': 'no-org-key1234' },
    });
    const interceptor = new IdempotencyInterceptor(reflector, makeService({}));
    const next = { handle: () => of({ ok: true }) };
    const result = await firstValueFrom(await interceptor.intercept(ctx, next));
    expect(result).toEqual({ ok: true });
  });

  it('IDEMPOTENT_KEY metadata constant is correctly named', () => {
    expect(IDEMPOTENT_KEY).toBe('idempotent');
  });
});
