import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedactionService } from '../redaction/redaction.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [AuthModule],
  providers: [ReconciliationService, RedactionService],
  controllers: [ReconciliationController],
  exports: [ReconciliationService, RedactionService],
})
export class ReconciliationModule {}
