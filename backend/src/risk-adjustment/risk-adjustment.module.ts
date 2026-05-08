import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HccRiskAdjustmentService } from './hcc.service';
import { HccCsvImporter } from './hcc-importer';
import { RiskAdjustmentController } from './risk-adjustment.controller';

@Module({
  imports: [AuthModule],
  providers: [HccRiskAdjustmentService, HccCsvImporter],
  controllers: [RiskAdjustmentController],
  exports: [HccRiskAdjustmentService, HccCsvImporter],
})
export class RiskAdjustmentModule {}
