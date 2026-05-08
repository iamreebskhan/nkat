import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { Edi270Controller } from './edi270.controller';

@Module({
  imports: [AuthModule],
  controllers: [Edi270Controller],
})
export class Edi270OutboundModule {}
