import { Module } from '@nestjs/common';
import { DatabaseModule, DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

/**
 * Global module — IdempotencyService + Interceptor are usable from any
 * controller without re-importing.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: IdempotencyService,
      inject: [DB_TOKEN],
      useFactory: (db: Db) => new IdempotencyService(db),
    },
    IdempotencyInterceptor,
  ],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
