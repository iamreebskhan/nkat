import { Module } from '@nestjs/common';
import { AscService } from './asc.service';

@Module({ providers: [AscService], exports: [AscService] })
export class AscModule {}
