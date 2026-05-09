/**
 * LoggingEmailClient — default `EmailClient` implementation. Writes the
 * outbound message to Pino at info level and returns a synthetic
 * message id. Used in:
 *   - dev / test environments (no SES wiring)
 *   - stage rehearsals before SES BAA executed
 *   - any environment where outbound mail should be a no-op observable
 */
import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { EmailClient, EmailMessage, EmailSendResult } from './email-types';

export class LoggingEmailClient implements EmailClient {
  private readonly log = new Logger('LoggingEmailClient');
  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const id = `log-${randomBytes(8).toString('hex')}`;
    this.log.log(`[no-send] to=${msg.to} from=${msg.from} subject="${msg.subject}" id=${id}`);
    return { messageId: id };
  }
}
