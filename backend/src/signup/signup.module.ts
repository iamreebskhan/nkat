import { Module } from '@nestjs/common';
import { STRIPE_CLIENT_TOKEN } from '../billing/billing-admin.controller';
import type { StripeClient } from '../billing/billing-types';
import { DatabaseModule, DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { InviteService } from '../invites/invite.service';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';

/**
 * SignupModule exposes the public anonymous signup endpoint. Depends on
 * BillingModule's global STRIPE_CLIENT_TOKEN provider + InviteModule's
 * global InviteService (both registered in AppModule).
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: SignupService,
      inject: [DB_TOKEN, STRIPE_CLIENT_TOKEN, InviteService],
      useFactory: (db: Db, stripe: StripeClient | undefined, invites: InviteService) =>
        new SignupService(db, stripe, invites),
    },
  ],
  controllers: [SignupController],
  exports: [SignupService],
})
export class SignupModule {}
