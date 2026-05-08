import { Module } from '@nestjs/common';
import { InstitutionalService } from './institutional.service';

@Module({ providers: [InstitutionalService], exports: [InstitutionalService] })
export class InstitutionalModule {}
