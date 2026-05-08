/**
 * One-click unsubscribe redeem endpoint.
 *
 *   GET  /v1/u/:token   → 200 with a tiny HTML confirmation
 *   POST /v1/u/:token   → 200 with JSON  (idempotent; re-clicks are no-ops)
 *
 * Anonymous (the token IS the auth). No rate limit at the application
 * layer — the verification step is a single HMAC compare which is
 * O(1); abusive traffic is a WAF/ALB concern.
 *
 * The redeem path:
 *   1. Verify the HMAC signature, expiry, and scope.
 *   2. UPSERT into `email_suppression` with `reason='manual_optout'`,
 *      `source='manual'`. Idempotent — repeated clicks update
 *      `suppressed_at` but don't error.
 *   3. Return a confirmation page (GET) or `{ ok: true, email }` (POST).
 *
 * Both verbs are accepted because email clients sometimes pre-fetch
 * URLs (Outlook ATP) or post via form. RFC 8058 (One-Click List-Unsubscribe)
 * recommends POST; we honor GET for simpler-link UX too.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Optional,
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { EMAIL_UNSUBSCRIBE_SECRET_TOKEN } from './email.service';
import { verifyUnsubscribeToken } from './unsubscribe-token';

@ApiTags('email')
@Controller('v1/u')
export class UnsubscribeController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Optional() @Inject(EMAIL_UNSUBSCRIBE_SECRET_TOKEN) private readonly secret?: string,
  ) {}

  @Get(':token')
  @Header('content-type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Redeem an unsubscribe token (browser-friendly GET)' })
  async getRedeem(@Param('token') token: string): Promise<string> {
    const email = await this.consume(token);
    return this.confirmationHtml(email);
  }

  @Post(':token')
  @ApiOperation({ summary: 'Redeem an unsubscribe token (RFC 8058 List-Unsubscribe POST)' })
  async postRedeem(@Param('token') token: string, @Body() _body?: unknown): Promise<{ ok: true; email: string }> {
    const email = await this.consume(token);
    return { ok: true, email };
  }

  private async consume(token: string): Promise<string> {
    if (!this.secret) {
      throw new ServiceUnavailableException({ code: 'UNSUBSCRIBE_NOT_CONFIGURED' });
    }
    const r = verifyUnsubscribeToken({ token, secret: this.secret, expectScope: 'manual_optout' });
    if (!r.ok) {
      // Same opaque error for malformed / bad_signature / expired —
      // probing learns nothing.
      throw new UnauthorizedException({ code: 'UNSUBSCRIBE_INVALID' });
    }
    const email = r.payload.email;
    await this.db
      .insertInto('email_suppression')
      .values({
        email,
        reason: 'manual_optout',
        source: 'manual',
        detail: 'one-click unsubscribe',
        expires_at: null,
      })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet({
          reason: sql`CASE WHEN email_suppression.reason = 'complaint' THEN email_suppression.reason ELSE 'manual_optout' END`,
          source: sql`'manual'`,
          detail: sql`'one-click unsubscribe'`,
          suppressed_at: sql`now()`,
        }),
      )
      .execute();
    return email;
  }

  private confirmationHtml(email: string): string {
    const safe = email.replace(/[<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return (
      `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#333}` +
      `h1{font-size:22px}p{line-height:1.5}</style></head><body>` +
      `<h1>You're unsubscribed</h1>` +
      `<p>We've removed <strong>${safe}</strong> from our outbound mailing list.</p>` +
      `<p>You'll still receive transactional messages we're legally required to send (e.g., billing receipts).</p>` +
      `<p>Changed your mind? Email support to be re-subscribed.</p>` +
      `</body></html>`
    );
  }
}
