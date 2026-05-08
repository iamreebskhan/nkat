import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CodesController } from './codes.controller';
import { CodeService } from './code.service';

@Module({
  imports: [AuthModule],
  providers: [CodeService],
  controllers: [CodesController],
  exports: [CodeService],
})
export class CodesModule {}
