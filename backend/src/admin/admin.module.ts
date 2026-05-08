import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SynthesisModule } from '../synthesis/synthesis.module';
import { AuditLogController } from './audit-log.controller';
import { CacheInvalidateController } from './cache-invalidate.controller';
import { DataExportController } from './data-export.controller';
import { ExtractionQueueController } from './extraction-queue.controller';
import { ExtractionQueueService } from './extraction-queue.service';
import { SuppressionController } from './suppression.controller';
import { TenantDeletionController } from './tenant-deletion.controller';
import { AuditLogRedactionController } from './audit-log-redaction.controller';
import { AuditLogRedactionService } from './audit-log-redaction.service';
import { RateLimitOverrideController } from './rate-limit-override.controller';

@Module({
  imports: [AuthModule, SynthesisModule],
  providers: [ExtractionQueueService, AuditLogRedactionService],
  controllers: [
    ExtractionQueueController,
    AuditLogController,
    DataExportController,
    SuppressionController,
    CacheInvalidateController,
    TenantDeletionController,
    AuditLogRedactionController,
    RateLimitOverrideController,
  ],
  exports: [ExtractionQueueService],
})
export class AdminModule {}
