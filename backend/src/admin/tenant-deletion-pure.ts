/**
 * Pure helpers for tenant data deletion. Decision logic lives here so
 * we can unit-test it without DB; the service does the I/O.
 */
export const MIN_NOTICE_DAYS = 30;
export const REQUIRED_CONFIRMATION_PREFIX = 'DELETE-TENANT-';

/**
 * Compute earliest_execute_at for a deletion request. Server-enforced
 * 30-day floor regardless of any "I want it deleted now" admin override.
 * MSA § 7.2 commits to this window.
 */
export function earliestExecuteAt(nowMs: number, requestedDays?: number): Date {
  const days = Math.max(MIN_NOTICE_DAYS, requestedDays ?? MIN_NOTICE_DAYS);
  return new Date(nowMs + days * 86_400_000);
}

/**
 * Validate the confirmation phrase. Must be EXACTLY:
 *   DELETE-TENANT-<short org slug>
 * Case-sensitive. Stops accidental deletion via UI form auto-fill.
 */
export function validateConfirmationPhrase(supplied: string, orgSlug: string): boolean {
  if (typeof supplied !== 'string') return false;
  const trimmed = supplied.trim();
  return trimmed === `${REQUIRED_CONFIRMATION_PREFIX}${orgSlug}`;
}

/**
 * Decide whether a deletion request is ready to execute given the
 * current state + clock. The executor relies on this so the gating
 * logic is auditable in one place.
 */
export interface DeletionReadyCheck {
  status: 'requested' | 'scheduled' | 'executed' | 'canceled' | 'failed';
  earliestExecuteAt: Date;
}

export function isReadyForExecution(req: DeletionReadyCheck, nowMs: number): boolean {
  if (req.status !== 'requested' && req.status !== 'scheduled') return false;
  return req.earliestExecuteAt.getTime() <= nowMs;
}
