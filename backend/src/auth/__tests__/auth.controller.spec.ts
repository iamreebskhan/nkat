/**
 * AuthController unit tests — `mode`, `me`, and the SSO redirect
 * are pure enough to test without a fake DB.
 */
import { AuthController } from '../auth.controller';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../../config/env';

function envOf(over: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgres://x',
    DB_APP_PASSWORD: '',
    BEDROCK_REGION: 'us-east-1',
    BEDROCK_MODEL_SYNTHESIS: '',
    BEDROCK_MODEL_PARSER: '',
    AUTH_MODE: 'dev_header',
    JWT_PUBLIC_KEY: undefined,
    JWT_JWKS_URL: undefined,
    JWT_ISSUER: undefined,
    JWT_AUDIENCE: undefined,
    OIDC_AUTHORIZATION_URL: undefined,
    OIDC_TOKEN_URL: undefined,
    OIDC_JWKS_URL: undefined,
    OIDC_CLIENT_ID: undefined,
    OIDC_CLIENT_SECRET: undefined,
    OIDC_REDIRECT_URI: undefined,
    OIDC_SCOPE: undefined,
    SSO_FRONTEND_REDIRECT: undefined,
    SESSION_SIGNING_PRIVATE_KEY: undefined,
    SESSION_TTL_SEC: 3600,
    ...over,
  } as Env;
}

describe('AuthController.mode', () => {
  it('reports dev_header + sso_configured=false when no OIDC', () => {
    const c = new AuthController(envOf());
    expect(c.mode()).toEqual({ mode: 'dev_header', sso_configured: false });
  });

  it('reports sso_configured=true when both URL + client id are set', () => {
    const c = new AuthController(envOf({
      AUTH_MODE: 'jwt',
      OIDC_AUTHORIZATION_URL: 'https://idp.example.com/oauth2/authorize',
      OIDC_CLIENT_ID: 'abc-client',
    }));
    expect(c.mode()).toEqual({ mode: 'jwt', sso_configured: true });
  });

  it('still false when only one of URL or client id is set', () => {
    const c = new AuthController(envOf({
      OIDC_AUTHORIZATION_URL: 'https://idp.example.com',
      // OIDC_CLIENT_ID intentionally missing
    }));
    expect(c.mode().sso_configured).toBe(false);
  });
});

describe('AuthController.ssoStart', () => {
  it('throws 503 when SSO is not configured', () => {
    const c = new AuthController(envOf());
    expect(() => c.ssoStart('/dest', { redirect: () => {} } as never))
      .toThrow(ServiceUnavailableException);
  });

  it('redirects with the canonical OIDC code-flow params', () => {
    const c = new AuthController(envOf({
      OIDC_AUTHORIZATION_URL: 'https://idp.example.com/oauth2/authorize',
      OIDC_CLIENT_ID: 'abc-client',
      OIDC_REDIRECT_URI: 'https://api.example.com/v1/auth/sso/callback',
      OIDC_SCOPE: 'openid profile email',
    }));
    let target = '';
    let status = 0;
    c.ssoStart('/lookup', {
      redirect: (s: number, url: string) => { status = s; target = url; },
    } as never);
    expect(status).toBe(302);
    expect(target).toContain('https://idp.example.com/oauth2/authorize?');
    expect(target).toContain('response_type=code');
    expect(target).toContain('client_id=abc-client');
    expect(target).toContain('scope=openid+profile+email');
    expect(target).toContain('state=%2Flookup');  // URL-encoded
  });

  it('uses default scope when env scope unset', () => {
    const c = new AuthController(envOf({
      OIDC_AUTHORIZATION_URL: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'x',
      OIDC_REDIRECT_URI: 'https://api.example.com/cb',
    }));
    let target = '';
    c.ssoStart(undefined, { redirect: (_: number, url: string) => { target = url; } } as never);
    expect(target).toContain('scope=openid+profile+email');
  });
});

describe('AuthController.me', () => {
  it('returns the auth context fields (db absent → orgSlug/orgName null)', async () => {
    const c = new AuthController(envOf());
    const out = await c.me({
      auth: {
        orgId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        role: 'admin',
      },
    } as never);
    expect(out).toEqual({
      orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
      orgSlug: null,
      orgName: null,
    });
  });

  it('returns nulls when auth context is somehow missing', async () => {
    const c = new AuthController(envOf());
    const out = await c.me({} as never);
    expect(out).toEqual({ orgId: null, userId: null, role: null, orgSlug: null, orgName: null });
  });
});
