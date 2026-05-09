import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule, DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { EmailService } from '../email/email.service';
import {
  InviteIssueController,
  InviteRedeemController,
  INVITE_REDEEM_BASE_URL_TOKEN,
} from './invite.controller';
import { InviteService } from './invite.service';

export interface InviteModuleOptions {
  /** Base URL used to render the redeem_url in admin issue responses. */
  redeemBaseUrl?: string;
}

@Module({})
export class InviteModule {
  static forRoot(opts: InviteModuleOptions = {}): DynamicModule {
    const baseUrl = opts.redeemBaseUrl ?? 'https://app.example.com';
    return {
      module: InviteModule,
      global: true,
      imports: [AuthModule, DatabaseModule],
      providers: [
        {
          provide: InviteService,
          inject: [DB_TOKEN, EmailService],
          useFactory: (db: Db, email: EmailService) => new InviteService(db, email, baseUrl),
        },
        { provide: INVITE_REDEEM_BASE_URL_TOKEN, useValue: baseUrl },
      ],
      controllers: [InviteIssueController, InviteRedeemController],
      exports: [InviteService],
    };
  }
}
