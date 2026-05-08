import { Module } from '@nestjs/common';
import { ENV_TOKEN } from '../config/config.module';
import { CmsCoverageApiClient } from './cms-coverage-api.client';
import { NcdLcdIngestor } from './ncd-lcd.ingestor';
import type { Env } from '../config/env';

@Module({
  providers: [
    {
      provide: 'CMS_CLIENT',
      inject: [ENV_TOKEN],
      useFactory: (env: Env): CmsCoverageApiClient => new CmsCoverageApiClient(env),
    },
    NcdLcdIngestor,
  ],
  exports: [NcdLcdIngestor, 'CMS_CLIENT'],
})
export class IngestionModule {}
