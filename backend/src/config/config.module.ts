import { Global, Module } from '@nestjs/common';
import { loadEnv, type Env } from './env';

export const ENV_TOKEN = Symbol('ENV');

/**
 * Global config module. Validates env once at startup and exposes the parsed
 * Env via dependency injection. No other module should call process.env.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV_TOKEN,
      useFactory: (): Env => loadEnv(),
    },
  ],
  exports: [ENV_TOKEN],
})
export class ConfigModule {}
