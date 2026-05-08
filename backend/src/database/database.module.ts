import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { createDb, type Db } from './db';
import { createPool } from './pool';

export const POOL_TOKEN = Symbol('PG_POOL');
export const DB_TOKEN = Symbol('DB');

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(POOL_TOKEN) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: POOL_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Pool => createPool(env),
    },
    {
      provide: DB_TOKEN,
      inject: [POOL_TOKEN],
      useFactory: (pool: Pool): Db => createDb(pool),
    },
    PoolLifecycle,
  ],
  exports: [POOL_TOKEN, DB_TOKEN],
})
export class DatabaseModule {}
