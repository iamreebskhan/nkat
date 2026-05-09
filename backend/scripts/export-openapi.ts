/* eslint-disable no-console */
/**
 * scripts/export-openapi.ts
 *
 * Boots the NestJS app in-process, captures the Swagger document, and writes
 * it to docs/openapi.json. Partner integrators consume this static spec.
 *
 *   npm run openapi:export
 *
 * Idempotent. Run as part of CI to keep the committed spec in sync with the
 * controllers / DTOs.
 */
// Env defaults must be set BEFORE we import any module that reads them.
// Nest's ConfigModule eagerly evaluates `loadEnv()` at provider-graph build
// time; if any required env var is missing zod throws and the catch
// handler downstream never gets a chance to run on some shell harnesses.
process.env.PGHOST ??= 'localhost';
process.env.PGDATABASE ??= 'billing_rules';
process.env.PGUSER ??= 'app';
process.env.PGPASSWORD ??= 'app_dev_only_change_in_prod';
process.env.LOG_LEVEL ??= 'silent';
process.env.STRIPE_WEBHOOK_SIGNING_SECRET ??= 'whsec_export_only_dummy';

import 'reflect-metadata';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

// Last-ditch error capture — write any uncaught error to a side file in
// case the ambient shell ate stderr.
const ERROR_LOG = path.resolve(__dirname, 'export-openapi.error.log');
function logFatal(scope: string, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  try {
    appendFileSync(ERROR_LOG, `[${scope}] ${msg}\n`);
  } catch {
    /* */
  }
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, msg);
}
process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logFatal('unhandledRejection', err);
  process.exit(1);
});
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';

async function main(): Promise<void> {
  // Provide minimum env for ConfigModule to validate. We never connect to a
  // real DB during the export — Nest constructs providers but doesn't run the
  // app's connection logic until `listen()` (which we skip).
  process.env.PGHOST ??= 'localhost';
  process.env.PGDATABASE ??= 'billing_rules';
  process.env.PGUSER ??= 'app';
  process.env.PGPASSWORD ??= 'app_dev_only_change_in_prod';
  process.env.LOG_LEVEL ??= 'silent';

  const app = await NestFactory.create(AppModule, { logger: false });
  const cfg = new DocumentBuilder()
    .setTitle('Billing Rules Platform API')
    .setDescription('Pre-flight a claim against payer × state × code rules.')
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', name: 'X-Org-Id', in: 'header' }, 'org-id')
    .build();
  const doc = SwaggerModule.createDocument(app, cfg);
  const outDir = path.resolve(__dirname, '..', '..', 'docs');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'openapi.json');
  writeFileSync(outFile, JSON.stringify(doc, null, 2));
  console.log(
    `exported → ${outFile}  (${doc.info.title} ${doc.info.version}, ${Object.keys(doc.paths ?? {}).length} paths)`,
  );
  await app.close();
}

main().catch((err) => {
  // Defense in depth — log to both stderr AND a side file in case the
  // ambient shell ate stderr (Windows / mingw redirects can be flaky).
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  console.error(msg);
  try {
    appendFileSync(path.resolve(__dirname, 'export-openapi.error.log'), msg + '\n');
  } catch {
    /* swallow */
  }
  process.exit(1);
});
