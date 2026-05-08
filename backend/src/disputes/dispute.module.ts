import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';

@Module({
  imports: [AuthModule],
  providers: [DisputeService],
  controllers: [DisputeController],
  exports: [DisputeService],
})
export class DisputeModule {}
