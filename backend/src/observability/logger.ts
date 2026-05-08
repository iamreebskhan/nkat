/**
 * Pino-based logger configuration with PHI/PII redaction.
 *
 * Redaction patterns target field names that commonly carry PHI/PII at
 * trust boundaries (request bodies, integration responses, etc.). This is
 * defence-in-depth: the application code should not be logging raw PHI in
 * the first place.
 */
import type { LoggerOptions } from 'pino';
import type { Env } from '../config/env';

/**
 * Field paths to redact wherever they appear in a logged object. Pino's
 * redact engine supports glob-style wildcards.
 */
export const PHI_REDACT_PATHS: string[] = [
  '*.patient_id',
  '*.patientId',
  '*.patient_external_id',
  '*.patientExternalId',
  '*.mrn',
  '*.MRN',
  '*.medical_record_number',
  '*.member_id',
  '*.memberId',
  '*.subscriber_id',
  '*.subscriberId',
  '*.ssn',
  '*.SSN',
  '*.dob',
  '*.DOB',
  '*.date_of_birth',
  '*.dateOfBirth',
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.Cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function buildLoggerOptions(env: Env): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: {
      paths: PHI_REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    base: {
      service: 'billing-rules-backend',
      env: env.NODE_ENV,
    },
  };

  if (env.NODE_ENV === 'development') {
    base.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    };
  }

  return base;
}
