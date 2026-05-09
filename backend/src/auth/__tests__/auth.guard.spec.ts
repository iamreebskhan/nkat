import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '../auth.guard';
import type { Env } from '../../config/env';

function makeCtx(headers: Record<string, string>): ExecutionContext {
  const req: { header: (k: string) => string | undefined; auth?: unknown } = {
    header: (key: string) => headers[key.toLowerCase()],
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const baseEnv = (overrides: Partial<Env> = {}): Env => ({
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  PORT: 3000,
  PGHOST: 'h',
  PGPORT: 5432,
  PGDATABASE: 'd',
  PGUSER: 'u',
  PGPASSWORD: 'p',
  PGSSLMODE: 'disable',
  PG_POOL_MAX: 10,
  PG_STATEMENT_TIMEOUT_MS: 5000,
  CMS_COVERAGE_API_BASE_URL: 'https://api.coverage.cms.gov',
  BEDROCK_REGION: 'us-east-1',
  BEDROCK_MODEL_SYNTHESIS: 'm',
  BEDROCK_MODEL_PARSER: 'm',
  AUTH_MODE: 'dev_header',
  SESSION_TTL_SEC: 3600,
  ...overrides,
});

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('AuthGuard (dev_header mode)', () => {
  it('accepts a valid X-Org-Id and attaches AuthContext to req', async () => {
    const guard = new AuthGuard(baseEnv());
    const ctx = makeCtx({ 'x-org-id': VALID_UUID });
    expect(await guard.canActivate(ctx)).toBe(true);
    const req = ctx.switchToHttp().getRequest<{ auth: { orgId: string } }>();
    expect(req.auth.orgId).toBe(VALID_UUID);
  });

  it('rejects when X-Org-Id is missing', async () => {
    const guard = new AuthGuard(baseEnv());
    const ctx = makeCtx({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when X-Org-Id is not a UUID', async () => {
    const guard = new AuthGuard(baseEnv());
    const ctx = makeCtx({ 'x-org-id': 'not-a-uuid' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when X-User-Id is provided but invalid', async () => {
    const guard = new AuthGuard(baseEnv());
    const ctx = makeCtx({ 'x-org-id': VALID_UUID, 'x-user-id': 'bad' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses dev_header in production', async () => {
    const guard = new AuthGuard(baseEnv({ NODE_ENV: 'production' }));
    const ctx = makeCtx({ 'x-org-id': VALID_UUID });
    await expect(guard.canActivate(ctx)).rejects.toThrow(/disabled in production/);
  });

  it('jwt mode rejects when neither JWKS nor PEM configured', async () => {
    const guard = new AuthGuard(baseEnv({ AUTH_MODE: 'jwt' }));
    const ctx = makeCtx({ authorization: 'Bearer xyz.zyx.foo' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      /Neither JWT_JWKS_URL nor JWT_PUBLIC_KEY configured/,
    );
  });

  it('jwt mode rejects when no Bearer header is present', async () => {
    const guard = new AuthGuard(baseEnv({ AUTH_MODE: 'jwt' }));
    const ctx = makeCtx({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(/Missing Bearer token/);
  });
});
