import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedactionController } from './redaction.controller';
import { RedactionService } from './redaction.service';

@Module({
  imports: [AuthModule],
  providers: [RedactionService],
  controllers: [RedactionController],
  exports: [RedactionService],
})
export class RedactionModule {}
