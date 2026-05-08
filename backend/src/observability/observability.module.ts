/**
 * Global module exposing the metrics emitter to the rest of the app.
 *
 *   constructor(private readonly metrics: MetricsService) {}
 *   metrics.increment('billing_rules.synthesis.cache_hit');
 *
 * Configured globally so consumer modules don't need to import.
 */
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatadogErrorReporter } from './error-reporter';
import { MetricsService } from './metrics.service';
import { UnhandledExceptionFilter } from './unhandled-exception.filter';

export const ERROR_REPORTER_TOKEN = Symbol('ERROR_REPORTER');

@Global()
@Module({
  providers: [
    MetricsService,
    DatadogErrorReporter,
    { provide: ERROR_REPORTER_TOKEN, useExisting: DatadogErrorReporter },
    // Wire the filter at the APP level — covers every route regardless
    // of which module registered the controller.
    { provide: APP_FILTER, useClass: UnhandledExceptionFilter },
  ],
  exports: [MetricsService, ERROR_REPORTER_TOKEN, DatadogErrorReporter],
})
export class ObservabilityModule {}
