/**
 * SES feedback controller — receives SNS Notifications for SES bounce,
 * complaint, and (optionally) delivery events. Updates the global
 * `email_suppression` list for permanent bounces and complaints; uses
 * a 24h auto-clear for transient bounces.
 *
 * Endpoint:  POST /v1/internal/ses-feedback
 *   - Anonymous (SNS posts unauthenticated; we authenticate via the
 *     RSA signature verification + topic-ARN allowlist).
 *   - Body is JSON-shaped per SNS spec.
 *
 * Topic-ARN allowlist is configured at module-init via
 * `SES_FEEDBACK_TOPIC_ARNS` env (comma-separated).
 *
 * SubscriptionConfirmation messages auto-confirm by GET'ing the
 * `SubscribeURL` — but ONLY when the topic ARN is in the allowlist
 * AND the SubscribeURL host matches the SigningCertURL host (i.e.,
 * only the AWS SNS endpoint can confirm us, never an attacker).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { URL } from 'node:url';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import {
  isAllowedCertUrl,
  isAllowedTopicArn,
  parseSesFeedbackPayload,
  type SnsEnvelope,
} from './sns-pure';
import { SnsVerifier, SnsVerifyError } from './sns-verifier';

export const SES_FEEDBACK_ALLOWED_ARNS_TOKEN = Symbol('SES_FEEDBACK_ALLOWED_ARNS');

@ApiTags('internal')
@Controller('v1/internal/ses-feedback')
export class SesFeedbackController {
  private readonly log = new Logger(SesFeedbackController.name);
  constructor(
    private readonly verifier: SnsVerifier,
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(SES_FEEDBACK_ALLOWED_ARNS_TOKEN) private readonly allowedArns: ReadonlySet<string>,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'SNS-delivered SES bounce/complaint feedback' })
  async receive(
    @Headers('x-amz-sns-message-type') messageType: string | undefined,
    @Body() rawEnvelope: unknown,
  ): Promise<{ ok: true; outcome: string }> {
    if (!rawEnvelope || typeof rawEnvelope !== 'object') {
      throw new BadRequestException('body must be a JSON object');
    }
    const envelope = rawEnvelope as SnsEnvelope;
    if (!envelope.Type || !envelope.Signature || !envelope.SigningCertURL || !envelope.TopicArn) {
      throw new BadRequestException('missing required SNS fields');
    }
    if (!isAllowedTopicArn(envelope.TopicArn, this.allowedArns)) {
      this.log.warn(`rejecting SNS for unallowed topic ${envelope.TopicArn}`);
      throw new UnauthorizedException({ code: 'TOPIC_NOT_ALLOWED' });
    }
    if (messageType && messageType !== envelope.Type) {
      throw new BadRequestException('Type header / body mismatch');
    }

    // Verify RSA signature before doing ANY further processing.
    try {
      await this.verifier.verify(envelope);
    } catch (e) {
      if (e instanceof SnsVerifyError) {
        this.log.warn(`SNS verify failed: ${e.code} ${e.message}`);
        throw new UnauthorizedException({ code: e.code });
      }
      throw e;
    }

    if (envelope.Type === 'SubscriptionConfirmation') {
      // Only fetch SubscribeURL when the host matches SigningCertURL host
      // — pinning subscription confirmation to the AWS SNS endpoint.
      const subUrl = envelope.SubscribeURL ?? '';
      try {
        const subHost = new URL(subUrl).hostname;
        const certHost = new URL(envelope.SigningCertURL).hostname;
        if (subHost !== certHost || !isAllowedCertUrl(envelope.SigningCertURL)) {
          throw new Error(`SubscribeURL host ${subHost} mismatched cert host ${certHost}`);
        }
        const r = await fetch(subUrl, { method: 'GET' });
        if (!r.ok) throw new Error(`SubscribeURL returned ${r.status}`);
        this.log.log(`confirmed subscription to ${envelope.TopicArn}`);
        return { ok: true, outcome: 'subscribed' };
      } catch (e) {
        this.log.warn(`subscription confirm failed: ${e instanceof Error ? e.message : String(e)}`);
        throw new BadRequestException('SubscribeURL invalid');
      }
    }

    if (envelope.Type === 'Notification') {
      const parsed = parseSesFeedbackPayload(envelope.Message);
      if (!parsed) {
        // Delivery / DeliveryDelay / unrecognized — log, no-op.
        return { ok: true, outcome: 'ignored' };
      }
      // Insert into the global suppression list. UPSERT on (email)
      // because a permanent bounce can later be followed by a
      // complaint; we keep the more-severe reason.
      for (const email of parsed.emails) {
        await this.db
          .insertInto('email_suppression')
          .values({
            email,
            reason: parsed.reason,
            source: 'ses_feedback',
            detail: parsed.detail.slice(0, 1024),
            expires_at: parsed.expiresAt,
          })
          .onConflict((oc) =>
            oc.column('email').doUpdateSet({
              // Upgrade to the new reason when the new event is more
              // severe (complaint > permanent_bounce > transient_bounce).
              reason: sql<typeof parsed.reason>`
                CASE
                  WHEN excluded.reason = 'complaint' THEN excluded.reason
                  WHEN excluded.reason = 'bounce_permanent' AND email_suppression.reason = 'bounce_transient' THEN excluded.reason
                  ELSE email_suppression.reason
                END
              `,
              source: sql`excluded.source`,
              detail: sql`excluded.detail`,
              expires_at: sql`
                CASE
                  WHEN excluded.reason IN ('complaint','bounce_permanent') THEN NULL
                  ELSE excluded.expires_at
                END
              `,
              suppressed_at: sql`now()`,
            }),
          )
          .execute();
      }
      this.log.log(
        `suppressed ${parsed.emails.length} email(s) reason=${parsed.reason} (topic=${envelope.TopicArn})`,
      );
      return { ok: true, outcome: `suppressed:${parsed.emails.length}` };
    }

    return { ok: true, outcome: 'noop' };
  }
}
