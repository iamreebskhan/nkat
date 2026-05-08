import 'reflect-metadata';
// Load `<cwd>/.env` if present BEFORE any module reads process.env.
// Uses Node's built-in (Node ≥20.12) so we add no runtime dependency.
// Production deploys ignore the file (env comes from ECS task secrets);
// .env is gitignored.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
{
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof (process as { loadEnvFile?: (p: string) => void }).loadEnvFile === 'function') {
    try {
      (process as { loadEnvFile: (p: string) => void }).loadEnvFile(envPath);
    } catch {
      /* tolerate malformed .env in dev — env validation will surface the real error */
    }
  }
}

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { buildLoggerOptions } from './observability/logger';
import pinoHttp from 'pino-http';

async function bootstrap(): Promise<INestApplication> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Disable the default body parser so we can install our own with:
    //   - a bumped limit (60 MB) for the Final Rules PDF upload
    //   - a `verify` hook that captures `req.rawBody` for the Stripe
    //     webhook (which needs the unparsed bytes for HMAC verification)
    bodyParser: false,
  });
  const express = await import('express');
  const captureRawBody: import('express').NextFunction extends infer _ ? (
    req: import('express').Request & { rawBody?: string },
    _res: import('express').Response,
    buf: Buffer,
    encoding: BufferEncoding,
  ) => void : never = (req, _res, buf, encoding) => {
    if (req.path === '/v1/billing/stripe-webhook') {
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  };
  app.use(express.json({ limit: '60mb', verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: '60mb' }));

  // Pino-based logger (replaces Nest's default).
  const httpLoggerMiddleware = pinoHttp(buildLoggerOptions(env));
  app.use(httpLoggerMiddleware);

  // Strict request validation everywhere.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // NB: URI versioning is NOT enabled — every controller in this
  // codebase already declares its own `v1/` prefix in @Controller(...).
  // Turning on `enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`
  // here would double-prefix and serve routes at `/v1/v1/...`, 404-ing
  // every legit URL (caught the hard way 2026-05-06).

  if (env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Billing Rules Platform API')
      .setDescription('Pre-flight a claim against payer × state × code rules.')
      .setVersion('0.1.0')
      .addApiKey({ type: 'apiKey', name: 'X-Org-Id', in: 'header' }, 'org-id')
      .build();
    const doc = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, doc);
  }

  app.enableShutdownHooks();
  await app.listen(env.PORT);
  // NB: Nest's default logger is fine for dev. Production wires
  // nestjs-pino via a LoggerModule import; that path replaces the
  // default at construction time, not via app.useLogger() here.
  // (Calling `app.get(PinoLogger)` when the provider isn't registered
  // calls Nest's internal teardown which `process.exit(1)`s — even
  // wrapping it in try/catch can't save us because the exit happens
  // before the throw reaches userspace.)
  return app;
}

bootstrap().catch((err) => {
  // Pre-init failure: stderr is the only safe sink.
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
