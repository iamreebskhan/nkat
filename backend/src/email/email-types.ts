/**
 * Email types — closed enums + the abstract `EmailClient` surface that
 * decouples EmailService from the concrete provider (SES today, but
 * any HTTPS-able provider tomorrow).
 */

export type EmailTemplate = 'invite' | 'welcome' | 'trial_ending' | 'dunning_past_due';

export interface EmailHeader {
  /** RFC 5322 header field name (e.g. `List-Unsubscribe`). */
  name: string;
  /** Header value. SES enforces a per-header byte cap; keep <= 998 chars. */
  value: string;
}

export interface EmailMessage {
  to: string; // single recipient (we never batch-fan-out PHI)
  from: string;
  subject: string;
  html: string;
  text: string; // plain-text fallback always supplied
  configurationSetName?: string;
  /**
   * Custom headers — most useful for RFC 8058 one-click unsubscribe
   * (`List-Unsubscribe` + `List-Unsubscribe-Post`). SESv2 SendEmail
   * with Simple content accepts these via `Content.Simple.Headers`.
   */
  headers?: EmailHeader[];
}

export interface EmailSendResult {
  /** Provider message id, e.g. SES MessageId. */
  messageId: string;
}

/** Abstract email surface. Production wiring uses SesV2EmailClient. */
export interface EmailClient {
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

export class EmailSendError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}
