import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DenialController } from './denial.controller';
import { DenialService } from './denial.service';

@Module({
  imports: [AuthModule],
  providers: [DenialService],
  controllers: [DenialController],
})
export class DenialModule {}
