/**
 * RedactionService — orchestrates PHI redaction for an uploaded client doc.
 *
 *   1. Run the configured redactor (regex_v1 today; Comprehend Medical
 *      tomorrow) over the input text.
 *   2. Persist the redacted text into `client_doc_upload`.
 *   3. Append a `redaction_event` audit row recording category counts only
 *      (NEVER the redacted strings themselves).
 *
 * Caller is responsible for opening `runWithTenant` so RLS applies.
 */
import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/rls-transaction';
import { redactPhi, REDACTOR_NAME, REDACTOR_VERSION, type RedactionResult } from './redactor';

export interface RedactInput {
  org_id: string;
  upload_id: string;
  raw_text: string;
  performed_by: string; // 'system' or analyst email
}

export interface RedactOutput {
  result: RedactionResult;
  upload_status: 'redacted';
  audit_event_id: string;
}

@Injectable()
export class RedactionService {
  /** Visible for tests so we can stub the redactor pure function if needed. */
  redact(input: string): RedactionResult {
    return redactPhi(input);
  }

  async redactAndPersist(tx: Tx, input: RedactInput): Promise<RedactOutput> {
    const result = this.redact(input.raw_text);

    await tx
      .updateTable('client_doc_upload')
      .set({
        redacted_text: result.redacted,
        redaction_summary: {
          category_counts: result.category_counts,
          total_redactions: result.total_redactions,
        },
        status: 'redacted',
      })
      .where('id', '=', input.upload_id)
      .where('org_id', '=', input.org_id)
      .execute();

    const audit = await tx
      .insertInto('redaction_event')
      .values({
        org_id: input.org_id,
        upload_id: input.upload_id,
        redactor_name: REDACTOR_NAME,
        redactor_version: REDACTOR_VERSION,
        category_counts: result.category_counts,
        total_redactions: result.total_redactions,
        performed_by: input.performed_by,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    return { result, upload_status: 'redacted', audit_event_id: audit.id };
  }
}
