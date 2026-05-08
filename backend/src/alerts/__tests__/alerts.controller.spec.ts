/**
 * Pure-mapper tests for the AlertsController's `toView`. The DB
 * query path is exercised in the integration suite.
 */
import { toView } from '../alerts.controller';

interface RowLike {
  id: string;
  org_id: string;
  client_id: string | null;
  rulebook_id: string | null;
  alert_type:
    | 'rule_change' | 'new_diff' | 'source_expired' | 'consent_required'
    | 'attestation_expiring' | 'extraction_drift' | 'source_unavailable';
  severity: 'critical' | 'high' | 'medium' | 'info';
  payload: Record<string, unknown>;
  related_rule_id: string | null;
  created_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  auto_resolved_at: Date | null;
}

function row(over: Partial<RowLike> = {}): RowLike {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    org_id: '22222222-2222-4222-8222-222222222222',
    client_id: null,
    rulebook_id: null,
    alert_type: 'rule_change',
    severity: 'high',
    payload: {},
    related_rule_id: null,
    created_at: new Date('2026-04-15T12:00:00Z'),
    acknowledged_at: null,
    acknowledged_by: null,
    auto_resolved_at: null,
    ...over,
  };
}

describe('AlertsController.toView', () => {
  it('emits FE-friendly fields (type, read_at, severity-3-bucket)', () => {
    const v = toView(row({
      alert_type: 'rule_change',
      severity: 'high',
      payload: { title: 'Rule X changed', detail: 'Effective May 1', payer_id: 'p-1' },
    }));
    expect(v).toMatchObject({
      type: 'rule_change',
      severity: 'warning',           // 'high' collapsed to 'warning'
      title: 'Rule X changed',
      detail: 'Effective May 1',
      payer_id: 'p-1',
      read_at: null,
    });
  });

  it('falls back to default title per alert_type when payload has none', () => {
    const titles: Record<RowLike['alert_type'], string> = {
      rule_change: 'A payer rule has changed',
      new_diff: 'New rule diff detected',
      source_expired: 'Authoritative source has expired',
      consent_required: 'Patient consent required (42 CFR Part 2)',
      attestation_expiring: 'Analyst attestation expiring soon',
      extraction_drift: 'Extractor accuracy drift detected',
      source_unavailable: 'Authoritative source is unreachable',
    };
    for (const [t, expected] of Object.entries(titles) as [RowLike['alert_type'], string][]) {
      expect(toView(row({ alert_type: t, payload: {} })).title).toBe(expected);
    }
  });

  it('maps the 4-bucket severity → 3-bucket UI severity', () => {
    expect(toView(row({ severity: 'critical' })).severity).toBe('critical');
    expect(toView(row({ severity: 'high' })).severity).toBe('warning');
    expect(toView(row({ severity: 'medium' })).severity).toBe('warning');
    expect(toView(row({ severity: 'info' })).severity).toBe('info');
  });

  it('reflects acknowledged_at as read_at (ISO string)', () => {
    const v = toView(row({ acknowledged_at: new Date('2026-04-16T09:30:00Z') }));
    expect(v.read_at).toBe('2026-04-16T09:30:00.000Z');
  });

  it('uses message as detail fallback when no detail key', () => {
    const v = toView(row({ payload: { message: 'fallback text' } }));
    expect(v.detail).toBe('fallback text');
  });

  it('returns null payer_id / effective_at when payload omits them', () => {
    const v = toView(row({ payload: {} }));
    expect(v.payer_id).toBeNull();
    expect(v.effective_at).toBeNull();
  });

  it('handles non-string payload values gracefully (e.g. numeric title)', () => {
    const v = toView(row({ payload: { title: 42 } }));
    // Non-string title → falls back to default for the type.
    expect(v.title).toBe('A payer rule has changed');
  });
});
