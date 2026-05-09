/**
 * DriftDetector — pure-function core for the alerting subsystem.
 *
 * Given a snapshot of the diff entries that EXISTED when a `client_rulebook`
 * was finalized, and a snapshot of the entries we'd compute today, produce
 * the list of NEW or CHANGED outcomes that should fire alerts.
 *
 * Outcome shifts that should always alert:
 *   - aligned → conflicting (we drifted away from the customer)
 *   - aligned → missing_in_authoritative (we deleted/expired a rule)
 *   - missing_in_client → conflicting (new authoritative rule)
 *   - any → conflicting where field_diffs introduces a new field
 *
 * Outcome shifts that DO NOT alert:
 *   - conflicting → aligned (good news; render as resolved if previously open)
 *   - missing_in_authoritative → conflicting (we just got a new rule; alert
 *     only if the customer's existing rule disagrees — yes, alert)
 *
 * Severity:
 *   - critical: aligned → conflicting OR aligned → missing_in_authoritative
 *   - high:    missing_in_client → conflicting OR new conflicting field_diff
 *   - medium:  effective_date shift on an aligned/conflicting row
 *   - info:    any other movement
 */
import type { DiffEntry, DiffSet } from '../reconciliation/diff-engine';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'info';

export interface DriftAlert {
  rulebook_id: string;
  key: DiffEntry['key'];
  previous_outcome: DiffEntry['outcome'] | 'absent';
  current_outcome: DiffEntry['outcome'] | 'absent';
  severity: AlertSeverity;
  /** Field-level changes when both sides are conflicting. */
  field_diffs?: string[];
  /** Helpful detail line for the alert UI. */
  detail: string;
}

const TRANSITION_SEVERITY: Record<string, AlertSeverity> = {
  'aligned->conflicting': 'critical',
  'aligned->missing_in_authoritative': 'critical',
  'missing_in_client->conflicting': 'high',
  'conflicting->conflicting': 'high',
  'aligned->missing_in_client': 'medium',
  'missing_in_authoritative->conflicting': 'high',
  'absent->conflicting': 'high',
  'absent->missing_in_authoritative': 'medium',
  'absent->missing_in_client': 'medium',
};

function entryKey(e: DiffEntry): string {
  return `${e.key.payer_id}|${e.key.state}|${e.key.product_line}|${e.key.code}|${e.key.attribute}`;
}

export function detectDrift(
  rulebook_id: string,
  baseline: DiffSet,
  current: DiffSet,
): DriftAlert[] {
  const baselineMap = new Map<string, DiffEntry>(
    baseline.entries.map((e): [string, DiffEntry] => [entryKey(e), e]),
  );
  const currentMap = new Map<string, DiffEntry>(
    current.entries.map((e): [string, DiffEntry] => [entryKey(e), e]),
  );

  const alerts: DriftAlert[] = [];
  const allKeys = new Set([...baselineMap.keys(), ...currentMap.keys()]);

  for (const k of allKeys) {
    const before = baselineMap.get(k);
    const after = currentMap.get(k);
    const beforeOutcome = before?.outcome ?? 'absent';
    const afterOutcome = after?.outcome ?? 'absent';
    if (
      beforeOutcome === afterOutcome &&
      (before?.field_diffs ?? []).join(',') === (after?.field_diffs ?? []).join(',')
    )
      continue;

    // Resolution case: any → aligned. Don't alert.
    if (afterOutcome === 'aligned' && beforeOutcome !== 'aligned') {
      continue;
    }

    const transition = `${beforeOutcome}->${afterOutcome}`;
    const severity: AlertSeverity = TRANSITION_SEVERITY[transition] ?? 'info';

    const detail = buildDetail(transition, before, after);
    const out: DriftAlert = {
      rulebook_id,
      key: (after ?? before)!.key,
      previous_outcome: beforeOutcome,
      current_outcome: afterOutcome,
      severity,
      detail,
    };
    if (after?.field_diffs) out.field_diffs = after.field_diffs;
    alerts.push(out);
  }

  // Stable order: critical first, then by key.
  const rank: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 };
  alerts.sort((a, b) => {
    const sa = rank[a.severity],
      sb = rank[b.severity];
    if (sa !== sb) return sa - sb;
    return entryKey({ outcome: 'aligned', key: a.key } as DiffEntry).localeCompare(
      entryKey({ outcome: 'aligned', key: b.key } as DiffEntry),
    );
  });
  return alerts;
}

function buildDetail(
  transition: string,
  before: DiffEntry | undefined,
  after: DiffEntry | undefined,
): string {
  const k = (after ?? before)!.key;
  const code = `${k.payer_id.slice(0, 8)} ${k.state}/${k.product_line}/${k.code}/${k.attribute}`;
  switch (transition) {
    case 'aligned->conflicting':
      return `Authoritative rule diverged from your finalized rulebook on ${code}. Field(s) differ: ${after?.field_diffs?.join(', ') ?? '?'}.`;
    case 'aligned->missing_in_authoritative':
      return `Authoritative rule for ${code} was retired. Your rulebook still has a value.`;
    case 'aligned->missing_in_client':
      return `New authoritative rule for ${code} appeared (was aligned at finalize? unlikely; likely effective-date shift).`;
    case 'missing_in_client->conflicting':
      return `New authoritative rule for ${code} conflicts with your custom rule.`;
    case 'missing_in_authoritative->conflicting':
      return `New authoritative rule appeared for ${code} that conflicts with your kept-client rule.`;
    case 'conflicting->conflicting':
      return `Existing conflict on ${code} now also differs on field(s): ${after?.field_diffs?.join(', ') ?? '?'}.`;
    case 'absent->missing_in_client':
      return `New authoritative rule for ${code}; your rulebook does not yet include it.`;
    case 'absent->conflicting':
      return `New authoritative rule for ${code} conflicts with an entry you added recently.`;
    default:
      return `Outcome changed: ${transition} on ${code}.`;
  }
}
