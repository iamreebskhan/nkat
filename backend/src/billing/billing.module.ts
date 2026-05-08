import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule, DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { EmailService } from '../email/email.service';
import { BillingAdminController, STRIPE_CLIENT_TOKEN } from './billing-admin.controller';
import { BillingController, STRIPE_SIGNING_SECRET_TOKEN } from './billing.controller';
import { BillingService } from './billing.service';
import type { StripeClient } from './billing-types';
import { StripeApiClient } from './stripe-api-client';
import { TierGuard } from './tier.guard';

export interface BillingModuleOptions {
  /**
   * Active Stripe webhook signing secret. Pass an array during a
   * rotation window: `[newSecret, previousSecret]`. The verifier
   * accepts a webhook signed by either, lets us update the dashboard
   * + the deployed config independently. Single string still works.
   */
  stripeSigningSecret: string | string[];
  /** When provided, the production StripeApiClient is used; tests pass a stub. */
  stripeApiKey?: string;
  stripeClient?: StripeClient;
  /** Used in welcome / dunning email links. */
  appUrl?: string;
}

@Module({})
export class BillingModule {
  static forRoot(opts: BillingModuleOptions): DynamicModule {
    const stripeProvider = opts.stripeClient
      ? { provide: STRIPE_CLIENT_TOKEN, useValue: opts.stripeClient }
      : opts.stripeApiKey
      ? {
          provide: STRIPE_CLIENT_TOKEN,
          useFactory: () => new StripeApiClient({ apiKey: opts.stripeApiKey! }),
        }
      : { provide: STRIPE_CLIENT_TOKEN, useValue: undefined };

    return {
      module: BillingModule,
      // Global so downstream modules (SignupModule) can inject
      // STRIPE_CLIENT_TOKEN + BillingService without re-importing.
      global: true,
      imports: [AuthModule, DatabaseModule],
      providers: [
        { provide: STRIPE_SIGNING_SECRET_TOKEN, useValue: opts.stripeSigningSecret },
        stripeProvider,
        {
          provide: BillingService,
          inject: [DB_TOKEN, EmailService, STRIPE_CLIENT_TOKEN],
          useFactory: (db: Db, email: EmailService, stripe?: StripeClient) =>
            new BillingService(db, email, opts.appUrl, stripe),
        },
        TierGuard,
      ],
      controllers: [BillingController, BillingAdminController],
      exports: [BillingService, TierGuard, STRIPE_CLIENT_TOKEN],
    };
  }
}
