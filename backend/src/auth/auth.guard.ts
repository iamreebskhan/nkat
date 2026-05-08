import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { isUuid } from '../common/uuid';
import type { AuthContext } from './auth-context';
import { JwksClient } from './jwks-client';
import { JwtVerifyError, verifyJwt } from './jwt-verifier';

export const JWKS_CLIENT_TOKEN = Symbol('JWKS_CLIENT');

/**
 * AuthGuard.
 *
 * Two modes selected by `AUTH_MODE`:
 *   - 'dev_header' — trusts X-Org-Id + X-User-Id headers. ONLY safe for
 *     local development. The guard refuses if NODE_ENV is 'production'.
 *   - 'jwt' — verifies the `Authorization: Bearer <token>` JWT against
 *     either:
 *        * a JWKS endpoint (preferred — `JWT_JWKS_URL` env), or
 *        * a static public key (`JWT_PUBLIC_KEY` env).
 *     Validates `iss`/`aud`/`exp`, extracts `org_id` + `sub` + custom
 *     `role` claim.
 *
 * The JWT path's claim shape is the contract our IdP must produce. The
 * IdP (Auth0, Clerk, Cognito, Okta) signs tokens whose payload includes:
 *
 *   {
 *     "iss": "https://idp.example.com",
 *     "aud": "<JWT_AUDIENCE>",
 *     "sub": "<user-uuid>",
 *     "org_id": "<tenant-uuid>",
 *     "role": "employee" | "reviewer" | "admin" | "consultant",
 *     "exp": <unix-seconds>
 *   }
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Optional() @Inject(JWKS_CLIENT_TOKEN) private readonly jwks?: JwksClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    if (this.env.AUTH_MODE === 'dev_header') {
      if (this.env.NODE_ENV === 'production') {
        throw new UnauthorizedException('dev_header auth is disabled in production');
      }
      const orgId = req.header('X-Org-Id');
      const userId = req.header('X-User-Id') ?? null;
      const role = (req.header('X-Role') ?? 'employee') as AuthContext['role'];

      if (!orgId || !isUuid(orgId)) {
        throw new UnauthorizedException('Missing or invalid X-Org-Id header');
      }
      if (userId && !isUuid(userId)) {
        throw new UnauthorizedException('Invalid X-User-Id header');
      }
      req.auth = { orgId, userId, role };
      return true;
    }

    // ---- AUTH_MODE === 'jwt' --------------------------------------------
    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header || !/^Bearer\s+/i.test(header)) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = header.replace(/^Bearer\s+/i, '').trim();

    // Prefer JWKS when configured; fall back to static PEM. Tests can
    // wire either via the constructor's optional injection.
    const verifyArgs: Parameters<typeof verifyJwt>[0] = {
      token,
      expectedIssuer: this.env.JWT_ISSUER,
      expectedAudience: this.env.JWT_AUDIENCE,
    };
    if (this.jwks) {
      verifyArgs.keyResolver = (kid) => this.jwks!.resolveKey(kid);
    } else if (this.env.JWT_PUBLIC_KEY) {
      verifyArgs.publicKeyPem = this.env.JWT_PUBLIC_KEY;
    } else {
      throw new UnauthorizedException('Neither JWT_JWKS_URL nor JWT_PUBLIC_KEY configured');
    }

    let claims;
    try {
      claims = await verifyJwt(verifyArgs);
    } catch (e) {
      if (e instanceof JwtVerifyError) {
        throw new UnauthorizedException({ code: 'JWT_INVALID' });
      }
      throw e;
    }

    const orgId = String((claims as { org_id?: unknown }).org_id ?? '');
    const userId = (claims as { sub?: unknown }).sub;
    const role = ((claims as { role?: unknown }).role ?? 'employee') as AuthContext['role'];
    if (!isUuid(orgId)) {
      throw new UnauthorizedException({ code: 'JWT_NO_ORG_ID' });
    }
    if (typeof userId !== 'string' || !isUuid(userId)) {
      throw new UnauthorizedException({ code: 'JWT_NO_SUB' });
    }
    req.auth = { orgId, userId, role };
    return true;
  }
}
