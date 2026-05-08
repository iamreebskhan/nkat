import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhookSubscriptionController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [AuthModule],
  providers: [WebhookService],
  controllers: [WebhookSubscriptionController],
  exports: [WebhookService],
})
export class WebhookModule {}
