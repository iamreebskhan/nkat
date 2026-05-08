/**
 * Per-tenant rate-limit overrides.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDel, apiGet, apiPut } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Table, type Column } from '../../components/Table';

interface OverrideRow {
  org_id: string;
  scope: string;
  limit: number;
  refill_per_sec: string | number;
  reason: string | null;
  set_by_user_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export function RateLimitPage() {
  const qc = useQueryClient();
  const [scope, setScope]       = useState('lookup');
  const [limit, setLimit]       = useState('60');
  const [refill, setRefill]     = useState('1');
  const [reason, setReason]     = useState('');
  const [expires, setExpires]   = useState('');
  const [err, setErr]           = useState<string | null>(null);

  const list = useQuery<{ items: OverrideRow[] }>({
    queryKey: ['rl-overrides'],
    queryFn: () => apiGet('/v1/admin/rate-limit/overrides'),
  });

  const upsert = useMutation<unknown, Error>({
    mutationFn: () => {
      setErr(null);
      const lim = Number(limit);
      const ref = Number(refill);
      if (!Number.isFinite(lim) || lim < 1 || lim > 1_000_000) {
        throw new Error('limit must be 1..1,000,000');
      }
      if (!Number.isFinite(ref) || ref < 0 || ref > 100_000) {
        throw new Error('refill must be 0..100,000');
      }
      return apiPut(`/v1/admin/rate-limit/overrides/${encodeURIComponent(scope)}`, {
        limit: lim,
        refillPerSec: ref,
        reason: reason || undefined,
        expiresAt: expires || undefined,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rl-overrides'] }),
    onError: (e) => setErr(e.message),
  });

  const remove = useMutation<unknown, Error, string>({
    mutationFn: (s) => apiDel(`/v1/admin/rate-limit/overrides/${encodeURIComponent(s)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rl-overrides'] }),
  });

  const cols: Column<OverrideRow>[] = [
    { header: 'Scope',         cell: (r) => <code>{r.scope}</code>, mono: true, width: '160px' },
    { header: 'Limit',         cell: (r) => r.limit.toLocaleString(), align: 'right', width: '100px' },
    { header: 'Refill / sec',  cell: (r) => String(r.refill_per_sec), mono: true, align: 'right', width: '120px' },
    { header: 'Reason',        cell: (r) => r.reason ?? '—' },
    { header: 'Expires',       cell: (r) => r.expires_at ? fmt(r.expires_at) : 'never', mono: true, width: '160px' },
    {
      header: '',
      cell: (r) => (
        <Button size="sm" variant="danger" onClick={() => remove.mutate(r.scope)} disabled={remove.isPending}>
          Remove
        </Button>
      ),
      width: '110px',
    },
  ];

  return (
    <>
      <PageHeader
        title="Rate limits"
        subtitle="Per-tenant overrides on the global decorator defaults. Resolver refreshes on every write — change is live within one request."
      />

      <Card title="Upsert override" severity={err ? 'error' : undefined}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 120px 1fr 200px', gap: 'var(--sp-3)' }}>
          <Input label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} />
          <Input label="Limit" type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
          <Input label="Refill/sec" type="number" min={0} step="0.0001" value={refill} onChange={(e) => setRefill(e.target.value)} />
          <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="enterprise contract, design partner, …" />
          <Input label="Expires (optional)" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </div>
        <div>
          <Button onClick={() => upsert.mutate()} loading={upsert.isPending}>Save</Button>
          {err && <p style={{ marginTop: 'var(--sp-2)', fontWeight: 700 }}>{err}</p>}
        </div>
      </Card>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        {list.isLoading && <p>Loading…</p>}
        {list.data && <Table rows={list.data.items} columns={cols} empty="No overrides — using decorator defaults." />}
      </div>
    </>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
