import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule, DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { FeatureFlagModule } from '../feature-flags/feature-flag.module';
import { CacheVersionService } from './cache-version.service';
import { DeterministicSynthesisProvider } from './deterministic-provider';
import { SynthesisController } from './synthesis.controller';
import { SynthesisService } from './synthesis.service';

@Module({
  imports: [AuthModule, FeatureFlagModule, DatabaseModule],
  providers: [
    DeterministicSynthesisProvider,
    SynthesisService,
    {
      provide: CacheVersionService,
      inject: [DB_TOKEN],
      useFactory: (db: Db) => new CacheVersionService(db),
    },
  ],
  controllers: [SynthesisController],
  exports: [SynthesisService, DeterministicSynthesisProvider, CacheVersionService],
})
export class SynthesisModule {}
