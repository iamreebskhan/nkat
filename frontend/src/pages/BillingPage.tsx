/**
 * Billing — entitlement summary. Read-only; the actual subscription
 * lives on Stripe and the customer portal lives there too.
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';

/**
 * Backend `BillingService.Entitlement` shape. The "no subscription"
 * fallback returns `{tier: null, active: false}`.
 */
interface Entitlement {
  tier: string | null;
  active: boolean;
  seats?: number;
  states?: string[];
  specialty_packs?: string[];
  status?: string;
  in_grace_period?: boolean;
  current_period_end?: string | null;
  trial_end?: string | null;
}

export function BillingPage() {
  const q = useQuery<Entitlement>({
    queryKey: ['entitlement'],
    queryFn: () => apiGet('/v1/billing/entitlement'),
  });

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Your active tier, seats, state coverage, and specialty packs. Subscription changes happen in the Stripe customer portal."
      />

      {q.isLoading && <p>Loading…</p>}
      {q.isError && <Card severity="error" title="Failed to load">{(q.error as Error).message}</Card>}
      {q.data && (
        <Card title={`${q.data.tier ?? 'No tier'} — ${q.data.active ? 'active' : 'inactive'}`} severity={q.data.active ? 'info' : 'warn'}>
          <dl style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 'var(--sp-2) var(--sp-4)', margin: 0 }}>
            <Row label="Seats" value={q.data.seats?.toLocaleString() ?? '—'} />
            <Row label="States"
              value={q.data.states?.length ? q.data.states.join(', ') : '—'} />
            <Row label="Specialty packs"
              value={q.data.specialty_packs?.length ? q.data.specialty_packs.join(', ') : '—'} />
            <Row label="Status" value={q.data.status ?? '—'} />
            <Row label="In grace period" value={q.data.in_grace_period ? 'yes' : 'no'} />
            <Row label="Period end"
              value={q.data.current_period_end ? new Date(q.data.current_period_end).toISOString().slice(0, 10) : '—'} />
            <Row label="Trial ends"
              value={q.data.trial_end ? new Date(q.data.trial_end).toISOString().slice(0, 10) : '—'} />
          </dl>
          <a href="/v1/billing/portal-redirect">→ Open Stripe customer portal</a>
        </Card>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'contents' }}>
      <dt style={{
        color: 'var(--fg-secondary)',
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}>{label}</dt>
      <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 14 }}>{value}</dd>
    </div>
  );
}
