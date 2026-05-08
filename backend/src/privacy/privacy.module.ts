import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrivacyController } from './privacy.controller';

@Module({
  imports: [AuthModule],
  controllers: [PrivacyController],
})
export class PrivacyModule {}
