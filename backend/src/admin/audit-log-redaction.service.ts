/**
 * Audit-log PII redaction surface — HIPAA right-to-amend break-glass.
 *
 * Audit-log payloads can leak PHI/PII (we try hard to keep them clean
 * but emergencies happen). This service lets a tenant admin scrub a
 * specific audit_log row's payload while preserving the row itself
 * (id, action, occurred_at, actor) so the timeline stays intact.
 *
 * Every redaction is itself audit-logged into `audit_log_redaction`
 * with the SHA-256 hash of the original payload — proving redaction
 * happened without re-leaking the redacted content.
 *
 * Pure-function helpers split out for unit-testing without the DB.
 */
import { createHash } from 'node:crypto';

export type RedactionType = 'payload_scrub' | 'payload_remove';

/**
 * Hash a JSON payload to a hex SHA-256. Stable across runs because we
 * use the canonical sorted-key serialization (deterministic).
 */
export function hashPayload(payload: unknown): string {
  const canonical = canonicalize(payload);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Canonicalize JSON for hashing. Sort object keys, recurse into
 * arrays + objects, leave primitives alone.
 */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(canonicalize).join(',') + ']';
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/**
 * Compute the replacement payload for a scrub operation. We keep the
 * structural shape for downstream tooling but zero out values:
 *   - strings → "[REDACTED]"
 *   - numbers → 0
 *   - booleans → false
 *   - null → null
 *   - arrays → [] (length stripped — array length itself can be PII)
 *   - objects → recurse over keys
 *
 * For 'payload_remove' we just return `{ redacted: true }`.
 */
export function computeRedactedPayload(
  original: unknown,
  type: RedactionType,
): Record<string, unknown> {
  if (type === 'payload_remove') {
    return { redacted: true };
  }
  // payload_scrub
  if (original === null || typeof original !== 'object') {
    return { redacted: true, value: '[REDACTED]' };
  }
  return scrubObject(original as Record<string, unknown>);
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { redacted: true };
  for (const [k, v] of Object.entries(obj)) {
    out[k] = scrubValue(v);
  }
  return out;
}

function scrubValue(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === 'string') return '[REDACTED]';
  if (typeof v === 'number') return 0;
  if (typeof v === 'boolean') return false;
  if (Array.isArray(v)) return [];
  if (typeof v === 'object') return scrubObject(v as Record<string, unknown>);
  return null;
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runWithTenant } from '../database/rls-transaction';

export interface RedactRequest {
  orgId: string;
  auditLogId: string;
  redactedByUserId: string;
  reason: string;
  type: RedactionType;
}

export interface RedactResult {
  audit_log_id: string;
  redaction_id: string;
  original_payload_hash: string;
  redaction_type: RedactionType;
}

@Injectable()
export class AuditLogRedactionService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async redact(req: RedactRequest): Promise<RedactResult> {
    return runWithTenant(this.db, req.orgId, async (tx) => {
      const row = await tx
        .selectFrom('audit_log')
        .select(['id', 'org_id', 'payload'])
        .where('id', '=', req.auditLogId)
        .executeTakeFirst();
      if (!row) {
        throw new NotFoundException({ code: 'AUDIT_LOG_NOT_FOUND' });
      }

      const hash = hashPayload(row.payload);
      const newPayload = computeRedactedPayload(row.payload, req.type);

      await tx
        .updateTable('audit_log')
        .set({ payload: newPayload })
        .where('id', '=', row.id)
        .execute();

      const inserted = await tx
        .insertInto('audit_log_redaction')
        .values({
          org_id: req.orgId,
          audit_log_id: row.id,
          redacted_by_user_id: req.redactedByUserId,
          reason: req.reason,
          redaction_type: req.type,
          original_payload_hash: hash,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Meta-audit-log: record that a redaction happened. This row
      // itself MUST NOT be redactable in the future (UX-level guard;
      // schema doesn't enforce, but the controller refuses).
      await tx
        .insertInto('audit_log')
        .values({
          org_id: req.orgId,
          user_id: req.redactedByUserId,
          action: 'audit_log.redact',
          target_type: 'audit_log',
          target_id: row.id,
          payload: {
            redaction_id: inserted.id,
            redaction_type: req.type,
            reason: req.reason,
            original_payload_hash: hash,
          },
          ip_address: null,
          user_agent: null,
        })
        .execute();

      return {
        audit_log_id: row.id,
        redaction_id: inserted.id,
        original_payload_hash: hash,
        redaction_type: req.type,
      };
    });
  }
}
