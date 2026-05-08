import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { BillingModule } from './billing/billing.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { RateLimitInterceptor } from './common/rate-limit/rate-limit.interceptor';
import { EmailModule } from './email/email.module';
import { InviteModule } from './invites/invite.module';
import { SignupModule } from './signup/signup.module';
import { AscModule } from './asc/asc.module';
import { AuthModule } from './auth/auth.module';
import { Cms0057Module } from './cms0057/cms0057.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DenialModule } from './denial/denial.module';
import { DisputeModule } from './disputes/dispute.module';
import { Edi271Module } from './ingestion/edi271/edi271.module';
import { Edi270OutboundModule } from './ingestion/edi270/edi270.module';
import { Edi837PModule } from './ingestion/edi837/edi837.module';
import { Era835Module } from './ingestion/era835/era835.module';
import { FeatureFlagModule } from './feature-flags/feature-flag.module';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { InstitutionalModule } from './institutional/institutional.module';
import { LookupModule } from './lookup/lookup.module';
import { ObservabilityModule } from './observability/observability.module';
import { ScimModule } from './scim/scim.module';
import { WellKnownController } from './well-known.controller';
import { AlertsModule } from './alerts/alerts.module';
import { ClearinghouseModule } from './clearinghouse/clearinghouse.module';
import { FinalRulesModule } from './final-rules/final-rules.module';
import { ClientsModule } from './clients/clients.module';
import { CodesModule } from './codes/codes.module';
import { AbnModule } from './abn/abn.module';
import { PrivacyModule } from './privacy/privacy.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { RedactionModule } from './redaction/redaction.module';
import { ReverificationModule } from './reverification/reverification.module';
import { RiskAdjustmentModule } from './risk-adjustment/risk-adjustment.module';
import { SynthesisModule } from './synthesis/synthesis.module';
import { WebhookModule } from './webhooks/webhook.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ObservabilityModule,
    AuthModule,
    HealthModule,
    LookupModule,
    IngestionModule,
    Era835Module,
    Edi271Module,
    Edi270OutboundModule,
    Edi837PModule,
    DenialModule,
    AlertsModule,
    ClearinghouseModule,
    FinalRulesModule,
    ClientsModule,
    CodesModule,
    AdminModule,
    ScimModule,
    AbnModule,
    PrivacyModule,
    RedactionModule,
    ReconciliationModule,
    DisputeModule,
    ReverificationModule,
    WebhookModule,
    Cms0057Module,
    RiskAdjustmentModule,
    FeatureFlagModule,
    SynthesisModule,
    AscModule,
    InstitutionalModule,
    BillingModule.forRoot({
      // During rotation, set BOTH STRIPE_WEBHOOK_SIGNING_SECRET (new)
      // and STRIPE_WEBHOOK_SIGNING_SECRET_PREVIOUS (old) — the
      // verifier accepts either. After ~24h with no PREVIOUS hits in
      // logs, retire the previous secret in Stripe dashboard + remove
      // the env var.
      stripeSigningSecret: [
        process.env.STRIPE_WEBHOOK_SIGNING_SECRET ?? '',
        process.env.STRIPE_WEBHOOK_SIGNING_SECRET_PREVIOUS ?? '',
      ].filter((s) => s.length > 0),
      stripeApiKey: process.env.STRIPE_API_KEY,
      appUrl: process.env.APP_BASE_URL,
    }),
    EmailModule.forRoot({
      fromAddress: process.env.EMAIL_FROM_ADDRESS ?? 'no-reply@example.com',
      configurationSet: process.env.SES_CONFIGURATION_SET,
      ...(process.env.SES_REGION ? { ses: { region: process.env.SES_REGION } } : {}),
      feedbackAllowedTopicArns: (process.env.SES_FEEDBACK_TOPIC_ARNS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      unsubscribeSecret: process.env.EMAIL_UNSUBSCRIBE_SECRET,
      unsubscribeBaseUrl: process.env.APP_BASE_URL,
    }),
    InviteModule.forRoot({ redeemBaseUrl: process.env.APP_BASE_URL }),
    SignupModule,
    IdempotencyModule,
    RateLimitModule.forRoot({}),
  ],
  controllers: [WellKnownController],
  providers: [
    // Globally registered — opt-in per-route via @Idempotent()
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // Globally registered — opt-in per-route via @RateLimit({...})
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
})
export class AppModule {}
