/**
 * SesV2EmailClient — production EmailClient that signs an HTTPS
 * `POST /v2/email/outbound-emails` to AWS SES with our SigV4 signer.
 * No SDK dependency.
 *
 * Credentials come from a credential provider function the caller
 * supplies (typically the ECS task IAM role's instance metadata; for
 * local dev, a static AccessKey/Secret pair from Secrets Manager).
 *
 * Caller is responsible for:
 *   - Verified-domain `from` address.
 *   - Configuration set name (so SES routes feedback to our SNS topic
 *     that drives the suppression list updater).
 */
import { Logger } from '@nestjs/common';
import {
  EmailSendError,
  type EmailClient,
  type EmailMessage,
  type EmailSendResult,
} from './email-types';
import { signRequest, type SigV4Credentials } from './sigv4';

export interface SesV2EmailClientOptions {
  region: string;
  /**
   * Provides current credentials at send-time (so STS-fetched ECS task
   * role creds get rotated transparently). Synchronous OR async OK.
   */
  credentialsProvider: () => Promise<SigV4Credentials> | SigV4Credentials;
  /** Override fetch for tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Override base URL for tests. */
  endpoint?: string;
}

export class SesV2EmailClient implements EmailClient {
  private readonly log = new Logger('SesV2EmailClient');
  private readonly fetch: typeof globalThis.fetch;
  private readonly endpoint: string;

  constructor(private readonly opts: SesV2EmailClientOptions) {
    if (!opts.region) throw new Error('SesV2EmailClient: region is required');
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.endpoint = opts.endpoint ?? `https://email.${opts.region}.amazonaws.com`;
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const credentials = await this.opts.credentialsProvider();

    const path = '/v2/email/outbound-emails';
    const body = JSON.stringify({
      FromEmailAddress: msg.from,
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: msg.text, Charset: 'UTF-8' },
            Html: { Data: msg.html, Charset: 'UTF-8' },
          },
          // RFC 8058 List-Unsubscribe + any other custom headers. SESv2
          // expects [{ Name, Value }] under Content.Simple.Headers.
          ...(msg.headers && msg.headers.length > 0
            ? { Headers: msg.headers.map((h) => ({ Name: h.name, Value: h.value })) }
            : {}),
        },
      },
      ...(msg.configurationSetName ? { ConfigurationSetName: msg.configurationSetName } : {}),
    });

    const host = this.endpoint.replace(/^https?:\/\//, '');
    const signed = signRequest({
      method: 'POST',
      path,
      query: '',
      headers: {
        host,
        'content-type': 'application/json',
      },
      body,
      region: this.opts.region,
      service: 'ses',
      credentials,
    });

    const r = await this.fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: signed.headers,
      body,
    });

    if (!r.ok) {
      const errBody = await r.text();
      let code = 'unknown';
      try {
        const parsed = JSON.parse(errBody) as { __type?: string; message?: string };
        code = parsed.__type ?? 'unknown';
      } catch { /* */ }
      this.log.warn(`SES send to=${msg.to} status=${r.status} code=${code}`);
      throw new EmailSendError(code, r.status, `SES ${r.status} ${code}: ${errBody.slice(0, 200)}`);
    }

    const j = (await r.json()) as { MessageId?: string };
    if (!j.MessageId) {
      throw new EmailSendError('NoMessageId', r.status, 'SES response missing MessageId');
    }
    return { messageId: j.MessageId };
  }
}
