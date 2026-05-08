import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { Edi837IController, Edi837PController } from './edi837.controller';

@Module({
  imports: [AuthModule],
  controllers: [Edi837PController, Edi837IController],
})
export class Edi837PModule {}
