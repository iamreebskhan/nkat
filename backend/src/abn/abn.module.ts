import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AbnController } from './abn.controller';
import { AbnService } from './abn.service';

@Module({
  imports: [AuthModule],
  providers: [AbnService],
  controllers: [AbnController],
  exports: [AbnService],
})
export class AbnModule {}
