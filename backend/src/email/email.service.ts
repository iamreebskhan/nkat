/**
 * EmailService — high-level send-templated-email API. Combines:
 *   1. Suppression-list check  (skip + record `suppressed`)
 *   2. Idempotency check       (skip + return existing send id)
 *   3. Template render          (pure)
 *   4. Provider send            (LoggingEmailClient or SesV2EmailClient)
 *   5. `email_send` audit row    (success or failure, both recorded)
 *
 * The service is stateless — all I/O is through the injected db / client.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { runWithTenant } from '../database/rls-transaction';
import type { Database } from '../database/schema.types';
import { renderTemplate, type RenderArgsFor } from './email-templates';
import { EmailSendError, type EmailClient, type EmailTemplate } from './email-types';
import { signUnsubscribeToken } from './unsubscribe-token';

export const EMAIL_CLIENT_TOKEN = Symbol('EMAIL_CLIENT');
export const EMAIL_FROM_TOKEN = Symbol('EMAIL_FROM');
export const EMAIL_CONFIGURATION_SET_TOKEN = Symbol('EMAIL_CONFIGURATION_SET');
export const EMAIL_UNSUBSCRIBE_SECRET_TOKEN = Symbol('EMAIL_UNSUBSCRIBE_SECRET');
export const EMAIL_UNSUBSCRIBE_BASE_URL_TOKEN = Symbol('EMAIL_UNSUBSCRIBE_BASE_URL');

/** Exponential backoff for the retry cron. ms per attempt index. */
const RETRY_BACKOFF_MS = [
  10 * 60 * 1000, // 10 min
  60 * 60 * 1000, // 1 h
  6 * 60 * 60 * 1000, // 6 h
  24 * 60 * 60 * 1000, // 24 h
];
export const MAX_RETRIES = RETRY_BACKOFF_MS.length;
export function nextRetryAt(attempt: number, nowMs: number = Date.now()): Date | null {
  if (attempt >= RETRY_BACKOFF_MS.length) return null;
  return new Date(nowMs + RETRY_BACKOFF_MS[attempt]);
}

export interface SendInput<T extends EmailTemplate = EmailTemplate> {
  /** Used for RLS scoping + audit. Some emails (e.g. cross-tenant ops) may pass null. */
  orgId: string | null;
  to: string;
  template: T;
  args: RenderArgsFor<T>;
  /** Idempotency key — same key skips duplicate sends. e.g. `invite-<token-id>`. */
  idempotencyKey?: string;
}

export interface SendResult {
  status: 'sent' | 'suppressed' | 'duplicate' | 'failed';
  message_id?: string;
  email_send_id: string;
}

@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);
  constructor(
    @Inject(EMAIL_CLIENT_TOKEN) private readonly client: EmailClient,
    @Inject(EMAIL_FROM_TOKEN) private readonly fromAddress: string,
    @Optional()
    @Inject(EMAIL_CONFIGURATION_SET_TOKEN)
    private readonly configurationSet: string | undefined,
    private readonly db: Kysely<Database>,
    @Optional() @Inject(EMAIL_UNSUBSCRIBE_SECRET_TOKEN) private readonly unsubscribeSecret?: string,
    @Optional()
    @Inject(EMAIL_UNSUBSCRIBE_BASE_URL_TOKEN)
    private readonly unsubscribeBaseUrl?: string,
  ) {}

  async send<T extends EmailTemplate>(input: SendInput<T>): Promise<SendResult> {
    const recipient = input.to.toLowerCase();
    const meta: { unsubscribe_url?: string } = {};
    let unsubscribeUrl: string | undefined;
    if (this.unsubscribeSecret && this.unsubscribeBaseUrl) {
      const tok = signUnsubscribeToken({
        payload: { email: recipient, scope: 'manual_optout' },
        secret: this.unsubscribeSecret,
      });
      unsubscribeUrl = `${this.unsubscribeBaseUrl.replace(/\/$/, '')}/v1/u/${encodeURIComponent(tok)}`;
      meta.unsubscribe_url = unsubscribeUrl;
    }
    const rendered = renderTemplate(input.template, input.args, meta);

    // 1. Suppression check (global, cross-tenant — see migration comment).
    const suppressed = await this.db
      .selectFrom('email_suppression')
      .select(['email', 'reason'])
      .where('email', '=', recipient)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .executeTakeFirst();
    if (suppressed) {
      const id = await this.recordAudit(
        input,
        recipient,
        rendered.subject,
        'suppressed',
        null,
        'SuppressionList',
        suppressed.reason,
      );
      this.log.warn(`email suppressed to=${recipient} reason=${suppressed.reason}`);
      return { status: 'suppressed', email_send_id: id };
    }

    // 2. Idempotency check.
    if (input.idempotencyKey) {
      const existing = await this.db
        .selectFrom('email_send')
        .select(['id', 'provider_message_id', 'status'])
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing && (existing.status === 'sent' || existing.status === 'suppressed')) {
        return {
          status: existing.status === 'sent' ? 'duplicate' : 'suppressed',
          email_send_id: existing.id,
          ...(existing.provider_message_id ? { message_id: existing.provider_message_id } : {}),
        };
      }
    }

    // 3+4. Send.
    let messageId: string | null = null;
    let errorClass: string | null = null;
    let errorDetail: string | null = null;
    let outcome: 'sent' | 'failed' = 'sent';
    try {
      const r = await this.client.send({
        to: recipient,
        from: this.fromAddress,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(this.configurationSet ? { configurationSetName: this.configurationSet } : {}),
        ...(unsubscribeUrl ? { headers: buildListUnsubscribeHeaders(unsubscribeUrl) } : {}),
      });
      messageId = r.messageId;
    } catch (e) {
      outcome = 'failed';
      if (e instanceof EmailSendError) {
        errorClass = e.code;
        errorDetail = e.message.slice(0, 1024);
      } else {
        errorClass = 'UnhandledException';
        errorDetail = (e instanceof Error ? e.message : String(e)).slice(0, 1024);
      }
      this.log.error(`email send failed to=${recipient} class=${errorClass}`);
    }

    const id = await this.recordAudit(
      input,
      recipient,
      rendered.subject,
      outcome,
      messageId,
      errorClass,
      errorDetail,
    );
    return outcome === 'sent'
      ? { status: 'sent', message_id: messageId!, email_send_id: id }
      : { status: 'failed', email_send_id: id };
  }

  /**
   * Retry a previously-failed email_send row. Idempotent at the
   * `idempotency_key` layer (a successful retry that races a duplicate
   * external trigger still won't re-mail). Updates the row in place to
   * `sent` (or schedules the next retry / dead-letters when MAX_RETRIES
   * exceeded).
   */
  async retryFailedSend(
    emailSendId: string,
  ): Promise<{ status: 'sent' | 'failed' | 'dead_lettered' | 'noop' }> {
    const row = await this.db
      .selectFrom('email_send')
      .selectAll()
      .where('id', '=', emailSendId)
      .executeTakeFirst();
    if (!row) return { status: 'noop' };
    if (row.status !== 'failed') return { status: 'noop' };
    if (row.retry_count >= MAX_RETRIES) {
      // Dead-letter — clear next_retry_at so we stop scanning it.
      await this.db
        .updateTable('email_send')
        .set({ next_retry_at: null, error_class: 'MaxRetriesExceeded' })
        .where('id', '=', emailSendId)
        .execute();
      return { status: 'dead_lettered' };
    }

    const meta: { unsubscribe_url?: string } = {};
    let unsubscribeUrl: string | undefined;
    if (this.unsubscribeSecret && this.unsubscribeBaseUrl) {
      const tok = signUnsubscribeToken({
        payload: { email: row.recipient, scope: 'manual_optout' },
        secret: this.unsubscribeSecret,
      });
      unsubscribeUrl = `${this.unsubscribeBaseUrl.replace(/\/$/, '')}/v1/u/${encodeURIComponent(tok)}`;
      meta.unsubscribe_url = unsubscribeUrl;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rendered = renderTemplate(row.template as EmailTemplate, row.args_snapshot as any, meta);

    let sent = false;
    let messageId: string | null = null;
    let errorClass: string | null = null;
    let errorDetail: string | null = null;
    try {
      const r = await this.client.send({
        to: row.recipient,
        from: this.fromAddress,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(this.configurationSet ? { configurationSetName: this.configurationSet } : {}),
        ...(unsubscribeUrl ? { headers: buildListUnsubscribeHeaders(unsubscribeUrl) } : {}),
      });
      sent = true;
      messageId = r.messageId;
    } catch (e) {
      if (e instanceof EmailSendError) {
        errorClass = e.code;
        errorDetail = e.message.slice(0, 1024);
      } else {
        errorClass = 'UnhandledException';
        errorDetail = (e instanceof Error ? e.message : String(e)).slice(0, 1024);
      }
    }

    const newAttempt = row.retry_count + 1;
    if (sent) {
      await this.db
        .updateTable('email_send')
        .set({
          status: 'sent',
          provider_message_id: messageId,
          sent_at: new Date(),
          retry_count: newAttempt,
          next_retry_at: null,
          error_class: null,
          error_detail: null,
        })
        .where('id', '=', emailSendId)
        .execute();
      return { status: 'sent' };
    }
    const next =
      isRetryable(errorClass) && newAttempt < MAX_RETRIES ? nextRetryAt(newAttempt) : null;
    await this.db
      .updateTable('email_send')
      .set({
        retry_count: newAttempt,
        error_class: errorClass,
        error_detail: errorDetail,
        next_retry_at: next,
      })
      .where('id', '=', emailSendId)
      .execute();
    return { status: next ? 'failed' : 'dead_lettered' };
  }

  private async recordAudit(
    input: SendInput,
    recipient: string,
    subject: string,
    status: 'sent' | 'suppressed' | 'failed',
    providerMessageId: string | null,
    errorClass: string | null,
    errorDetail: string | null,
  ): Promise<string> {
    const insert = (tx: Kysely<Database>) =>
      tx
        .insertInto('email_send')
        .values({
          org_id: input.orgId,
          template: input.template,
          recipient,
          subject,
          status,
          provider_message_id: providerMessageId,
          error_class: errorClass,
          error_detail: errorDetail,
          idempotency_key: input.idempotencyKey ?? null,
          sent_at: status === 'sent' ? new Date() : null,
          // Snapshot the args so the retry cron can re-render exactly the
          // same message. We persist the typed args (PHI-free by template
          // contract) — never the rendered HTML/text (lots of bytes for
          // no win).
          args_snapshot: input.args as unknown as Record<string, unknown>,
          next_retry_at: status === 'failed' && isRetryable(errorClass) ? nextRetryAt(0) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

    const row = input.orgId
      ? await runWithTenant(this.db, input.orgId, (tx) => insert(tx))
      : await insert(this.db);
    return row.id;
  }
}

/**
 * Build RFC 8058 List-Unsubscribe + List-Unsubscribe-Post headers from
 * the unsubscribe URL. Two headers, both required for one-click:
 *
 *   List-Unsubscribe: <https://app/v1/u/TOKEN>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The presence of `List-Unsubscribe-Post` tells Gmail / Apple Mail /
 * Outlook to render a native "Unsubscribe" button next to the sender,
 * and to POST the URL on click instead of opening a browser tab.
 *
 * Per RFC 8058 the URL must be wrapped in <angle brackets>. We do NOT
 * include a mailto: alternative — keeping the surface to one verb
 * (HTTP) limits attack surface and matches our redeem endpoint.
 */
export function buildListUnsubscribeHeaders(
  unsubscribeUrl: string,
): Array<{ name: string; value: string }> {
  return [
    { name: 'List-Unsubscribe', value: `<${unsubscribeUrl}>` },
    { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
  ];
}

/**
 * Decide whether a failed send should be retried.
 * - Throttling, network blips, internal errors → retry.
 * - Permanent failures (validation, MessageRejected) → don't retry.
 * Conservative: when in doubt, retry.
 */
export function isRetryable(errorClass: string | null): boolean {
  if (!errorClass) return false;
  switch (errorClass) {
    case 'MessageRejected':
    case 'MailFromDomainNotVerifiedException':
    case 'AccountSuspendedException':
    case 'SuppressionList': // already handled upstream
    case 'NoMessageId': // shape mismatch, won't fix on retry
      return false;
    case 'ThrottlingException':
    case 'TooManyRequestsException':
    case 'InternalServerError':
    case 'UnhandledException':
      return true;
    default:
      return true; // unknown → cautious retry
  }
}
