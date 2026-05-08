/**
 * Auth bootstrap surface.
 *
 *   GET /v1/auth/sso/start?next=…   — kick off the OIDC flow with the
 *                                      configured IdP. When no IdP is
 *                                      wired, returns 503 with a clear
 *                                      message so the LoginPage can
 *                                      degrade gracefully.
 *   GET /v1/auth/me                  — returns the calling tenant's
 *                                      identity claims (proxies through
 *                                      AuthGuard so the FE can rehydrate
 *                                      after a refresh).
 *   GET /v1/auth/mode                — exposes which auth mode the
 *                                      backend is in (dev_header / jwt)
 *                                      so the FE can hide the SSO button
 *                                      when irrelevant. PUBLIC.
 */
import {
  Controller,
  Get,
  Inject,
  Optional,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { isUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';
import { AuthGuard } from './auth.guard';
import { JwksClient } from './jwks-client';
import { verifyJwt } from './jwt-verifier';
import { JwtSigningError, parsePrivateKey, signJwt } from './sign-jwt';

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Optional() @Inject(DB_TOKEN) private readonly db?: Db,
  ) {}

  @Get('mode')
  @ApiOperation({ summary: 'Reveal the active auth mode (dev_header / jwt) — public, no PII.' })
  mode(): { mode: 'dev_header' | 'jwt'; sso_configured: boolean } {
    return {
      mode: this.env.AUTH_MODE,
      sso_configured: Boolean(this.env.OIDC_AUTHORIZATION_URL && this.env.OIDC_CLIENT_ID),
    };
  }

  @Get('sso/start')
  @ApiOperation({ summary: 'Begin OIDC flow to the configured IdP. 503 when IdP is not configured.' })
  ssoStart(@Query('next') next: string | undefined, @Res() res: Response) {
    if (!this.env.OIDC_AUTHORIZATION_URL || !this.env.OIDC_CLIENT_ID) {
      throw new ServiceUnavailableException({
        code: 'SSO_NOT_CONFIGURED',
        detail:
          'Set OIDC_AUTHORIZATION_URL + OIDC_CLIENT_ID + OIDC_REDIRECT_URI to enable SSO. ' +
          'Until then use AUTH_MODE=dev_header in non-prod environments.',
      });
    }
    // URLSearchParams encodes values on toString(); passing the raw
    // `next` here is correct. Double-encoding (encodeURIComponent +
    // URLSearchParams) was a real bug caught by the unit test.
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.env.OIDC_CLIENT_ID,
      redirect_uri: this.env.OIDC_REDIRECT_URI ?? '',
      scope: this.env.OIDC_SCOPE ?? 'openid profile email',
      state: next ?? '/',
    });
    res.redirect(302, `${this.env.OIDC_AUTHORIZATION_URL}?${params.toString()}`);
  }

  @Get('sso/callback')
  @ApiOperation({
    summary:
      'OIDC authorization-code-flow callback. Exchanges `code` for the IdP\'s ID token, ' +
      'verifies it via OIDC_JWKS_URL, mints OUR session JWT (RS256), and redirects to the ' +
      'frontend with the token in the URL fragment.',
  })
  async ssoCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    // Pre-flight: every required env var must be set.
    const missing = [
      ['OIDC_TOKEN_URL', this.env.OIDC_TOKEN_URL],
      ['OIDC_JWKS_URL', this.env.OIDC_JWKS_URL],
      ['OIDC_CLIENT_ID', this.env.OIDC_CLIENT_ID],
      ['OIDC_CLIENT_SECRET', this.env.OIDC_CLIENT_SECRET],
      ['OIDC_REDIRECT_URI', this.env.OIDC_REDIRECT_URI],
      ['JWT_ISSUER', this.env.JWT_ISSUER],
      ['JWT_AUDIENCE', this.env.JWT_AUDIENCE],
      ['SESSION_SIGNING_PRIVATE_KEY', this.env.SESSION_SIGNING_PRIVATE_KEY],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
      throw new ServiceUnavailableException({
        code: 'SSO_NOT_CONFIGURED',
        missing,
      });
    }
    if (!code) {
      throw new ServiceUnavailableException({ code: 'OIDC_NO_CODE' });
    }
    const next = decodeURIComponent(state ?? '/');

    // 1. Exchange code → IdP token endpoint.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.env.OIDC_REDIRECT_URI!,
      client_id: this.env.OIDC_CLIENT_ID!,
      client_secret: this.env.OIDC_CLIENT_SECRET!,
    });
    const tokenRes = await fetch(this.env.OIDC_TOKEN_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text().catch(() => '');
      throw new ServiceUnavailableException({
        code: 'OIDC_TOKEN_EXCHANGE_FAILED',
        status: tokenRes.status,
        detail: txt.slice(0, 500),
      });
    }
    const tokenJson = (await tokenRes.json()) as { id_token?: string };
    if (!tokenJson.id_token || typeof tokenJson.id_token !== 'string') {
      throw new ServiceUnavailableException({ code: 'OIDC_NO_ID_TOKEN' });
    }

    // 2. Verify the IdP's id_token using its JWKS.
    const idpJwks = new JwksClient(this.env.OIDC_JWKS_URL!);
    let claims: Record<string, unknown>;
    try {
      claims = (await verifyJwt({
        token: tokenJson.id_token,
        expectedIssuer: this.env.JWT_ISSUER!,
        expectedAudience: this.env.OIDC_CLIENT_ID!,
        keyResolver: (kid) => idpJwks.resolveKey(kid),
      })) as Record<string, unknown>;
    } catch (e) {
      throw new ServiceUnavailableException({
        code: 'OIDC_ID_TOKEN_INVALID',
        detail: (e as Error).message,
      });
    }
    const sub = String(claims.sub ?? '');
    const orgId = String((claims as { org_id?: unknown }).org_id ?? '');
    const role = String((claims as { role?: unknown }).role ?? 'employee');
    if (!isUuid(sub) || !isUuid(orgId)) {
      throw new ServiceUnavailableException({ code: 'OIDC_BAD_CLAIMS' });
    }

    // 3. Mint OUR session JWT (RS256). AuthGuard's jwt-mode verifies it
    //    via JWT_PUBLIC_KEY, which the operator sets to the public half
    //    of SESSION_SIGNING_PRIVATE_KEY.
    let sessionToken: string;
    try {
      const privateKey = parsePrivateKey(this.env.SESSION_SIGNING_PRIVATE_KEY!);
      sessionToken = signJwt({
        privateKey,
        kid: 'session-1',
        claims: {
          iss: this.env.JWT_ISSUER!,
          aud: this.env.JWT_AUDIENCE!,
          sub,
          org_id: orgId,
          role,
          ttlSec: this.env.SESSION_TTL_SEC,
        },
      });
    } catch (e) {
      const code = e instanceof JwtSigningError ? e.code : 'SESSION_SIGN_FAILED';
      throw new ServiceUnavailableException({ code, detail: (e as Error).message });
    }

    // 4. Redirect to FE with the token in the URL fragment (so it
    //    never lands in server access logs or referrer headers).
    const feBase = this.env.SSO_FRONTEND_REDIRECT ?? this.env.OIDC_REDIRECT_URI!;
    const feUrl = new URL('/login', feBase);
    feUrl.hash = new URLSearchParams({ token: sessionToken, next }).toString();
    res.redirect(302, feUrl.toString());
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Return the calling principal — orgId, userId, role + org slug/name for UI display.',
  })
  async me(@Req() req: Request) {
    const orgId = req.auth?.orgId ?? null;
    const userId = req.auth?.userId ?? null;
    const role = req.auth?.role ?? null;
    let orgSlug: string | null = null;
    let orgName: string | null = null;
    if (orgId && this.db) {
      try {
        // RLS scopes the lookup to the caller's own org row.
        const r = await runReadOnlyWithTenant(this.db, orgId, async (tx) =>
          tx
            .selectFrom('org')
            .select(['slug', 'name'])
            .where('id', '=', orgId)
            .executeTakeFirst(),
        );
        orgSlug = r?.slug ?? null;
        orgName = r?.name ?? null;
      } catch {
        // DB down or org row missing — degrade silently. The FE still
        // gets orgId so UUID-based features work.
      }
    }
    return { orgId, userId, role, orgSlug, orgName };
  }
}
