import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AlertsController } from './alerts.controller';

@Module({
  imports: [AuthModule],
  controllers: [AlertsController],
})
export class AlertsModule {}
