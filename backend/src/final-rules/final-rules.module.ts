import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FinalRulesController } from './final-rules.controller';

@Module({
  imports: [AuthModule],
  controllers: [FinalRulesController],
})
export class FinalRulesModule {}
