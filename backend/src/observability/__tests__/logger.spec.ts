import pino from 'pino';
import { Writable } from 'node:stream';
import { buildLoggerOptions } from '../logger';
import type { Env } from '../../config/env';

function captureLogs(): { dest: Writable; events: object[] } {
  const events: object[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      const line = chunk.toString('utf8').trim();
      if (line) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* non-JSON pretty mode; ignore */
        }
      }
      cb();
    },
  });
  return { dest, events };
}

const env: Env = {
  NODE_ENV: 'production', // forces JSON output, not pretty
  LOG_LEVEL: 'info',
  PORT: 3000,
  PGHOST: 'h',
  PGPORT: 5432,
  PGDATABASE: 'd',
  PGUSER: 'u',
  PGPASSWORD: 'p',
  PGSSLMODE: 'disable',
  PG_POOL_MAX: 10,
  PG_STATEMENT_TIMEOUT_MS: 5000,
  CMS_COVERAGE_API_BASE_URL: 'https://api.coverage.cms.gov',
  BEDROCK_REGION: 'us-east-1',
  BEDROCK_MODEL_SYNTHESIS: 'm',
  BEDROCK_MODEL_PARSER: 'm',
  AUTH_MODE: 'dev_header',
  SESSION_TTL_SEC: 3600,
};

describe('logger redaction', () => {
  it('redacts patient identifiers wherever they appear', () => {
    const { dest, events } = captureLogs();
    const log = pino(buildLoggerOptions(env), dest);

    log.info(
      {
        request: {
          mrn: '1234567',
          patient_external_id: 'abc-123',
          dob: '1950-04-12',
        },
      },
      'lookup',
    );

    expect(events).toHaveLength(1);
    const e = events[0] as { request: Record<string, string> };
    expect(e.request.mrn).toBe('[REDACTED]');
    expect(e.request.patient_external_id).toBe('[REDACTED]');
    expect(e.request.dob).toBe('[REDACTED]');
  });

  it('redacts authorization and cookie headers', () => {
    const { dest, events } = captureLogs();
    const log = pino(buildLoggerOptions(env), dest);

    log.info(
      {
        req: {
          headers: {
            authorization: 'Bearer secret',
            cookie: 'session=abc',
            'x-trace-id': 'visible',
          },
        },
      },
      'request',
    );

    const e = events[0] as { req: { headers: Record<string, string> } };
    expect(e.req.headers.authorization).toBe('[REDACTED]');
    expect(e.req.headers.cookie).toBe('[REDACTED]');
    expect(e.req.headers['x-trace-id']).toBe('visible');
  });

  it('does not redact ordinary fields', () => {
    const { dest, events } = captureLogs();
    const log = pino(buildLoggerOptions(env), dest);

    log.info({ payer: 'Medicare', code: '99497', state: 'OH' }, 'rule lookup');

    const e = events[0] as Record<string, string>;
    expect(e.payer).toBe('Medicare');
    expect(e.code).toBe('99497');
    expect(e.state).toBe('OH');
  });
});
