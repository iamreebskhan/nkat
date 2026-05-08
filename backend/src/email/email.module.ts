import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule, DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import {
  EMAIL_CLIENT_TOKEN,
  EMAIL_CONFIGURATION_SET_TOKEN,
  EMAIL_FROM_TOKEN,
  EMAIL_UNSUBSCRIBE_BASE_URL_TOKEN,
  EMAIL_UNSUBSCRIBE_SECRET_TOKEN,
  EmailService,
} from './email.service';
import { UnsubscribeController } from './unsubscribe.controller';
import type { EmailClient } from './email-types';
import { LoggingEmailClient } from './logging-email-client';
import { SES_FEEDBACK_ALLOWED_ARNS_TOKEN, SesFeedbackController } from './ses-feedback.controller';
import { SesV2EmailClient } from './ses-v2-email-client';
import type { SigV4Credentials } from './sigv4';
import { SnsVerifier } from './sns-verifier';

export interface EmailModuleOptions {
  fromAddress: string;
  /** SES configuration set (drives feedback → SNS → suppression list). */
  configurationSet?: string;
  /**
   * Production wiring: pass `{ region }` (and a credentials provider) to
   * use SesV2EmailClient. If unset, LoggingEmailClient is used (default).
   */
  ses?: {
    region: string;
    credentialsProvider?: () => Promise<SigV4Credentials> | SigV4Credentials;
  };
  /** Test override. */
  client?: EmailClient;
  /** Topic ARNs allowed to drive `email_suppression` updates via /v1/internal/ses-feedback. */
  feedbackAllowedTopicArns?: string[];
  /** HMAC secret for one-click unsubscribe links. When unset, the unsubscribe footer is not rendered + the redeem endpoint always 401s. */
  unsubscribeSecret?: string;
  /** Base URL the unsubscribe footer links to, e.g. https://app.example.com */
  unsubscribeBaseUrl?: string;
}

@Module({})
export class EmailModule {
  static forRoot(opts: EmailModuleOptions): DynamicModule {
    let client: EmailClient;
    if (opts.client) {
      client = opts.client;
    } else if (opts.ses) {
      const provider =
        opts.ses.credentialsProvider ??
        (() => {
          const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
          const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
          const sessionToken = process.env.AWS_SESSION_TOKEN;
          if (!accessKeyId || !secretAccessKey) {
            throw new Error(
              'EmailModule: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY required when no credentialsProvider supplied',
            );
          }
          return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
        });
      client = new SesV2EmailClient({ region: opts.ses.region, credentialsProvider: provider });
    } else {
      client = new LoggingEmailClient();
    }
    return {
      module: EmailModule,
      global: true,
      imports: [DatabaseModule],
      providers: [
        { provide: EMAIL_CLIENT_TOKEN, useValue: client },
        { provide: EMAIL_FROM_TOKEN, useValue: opts.fromAddress },
        { provide: EMAIL_CONFIGURATION_SET_TOKEN, useValue: opts.configurationSet },
        { provide: EMAIL_UNSUBSCRIBE_SECRET_TOKEN, useValue: opts.unsubscribeSecret },
        { provide: EMAIL_UNSUBSCRIBE_BASE_URL_TOKEN, useValue: opts.unsubscribeBaseUrl },
        {
          provide: EmailService,
          inject: [
            EMAIL_CLIENT_TOKEN,
            EMAIL_FROM_TOKEN,
            EMAIL_CONFIGURATION_SET_TOKEN,
            DB_TOKEN,
            EMAIL_UNSUBSCRIBE_SECRET_TOKEN,
            EMAIL_UNSUBSCRIBE_BASE_URL_TOKEN,
          ],
          useFactory: (
            c: EmailClient,
            from: string,
            configSet: string | undefined,
            db: Db,
            unsubSecret: string | undefined,
            unsubBaseUrl: string | undefined,
          ) => new EmailService(c, from, configSet, db, unsubSecret, unsubBaseUrl),
        },
        SnsVerifier,
        {
          provide: SES_FEEDBACK_ALLOWED_ARNS_TOKEN,
          useValue: new Set(opts.feedbackAllowedTopicArns ?? []),
        },
      ],
      controllers: [SesFeedbackController, UnsubscribeController],
      exports: [EmailService],
    };
  }
}
