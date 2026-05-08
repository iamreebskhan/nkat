import { Module } from '@nestjs/common';
import { ReverificationService } from './reverification.service';

@Module({
  providers: [ReverificationService],
  exports: [ReverificationService],
})
export class ReverificationModule {}
