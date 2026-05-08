/**
 * Alert inbox. Filter by severity + state. Mark-as-read flips the
 * `read_at` field; severity is shown by left-border weight.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../api/client';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { Select } from '../components/Select';

interface Alert {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string | null;
  payer_id: string | null;
  effective_at: string | null;
  read_at: string | null;
  created_at: string;
}

export function AlertsPage() {
  const qc = useQueryClient();
  const [severity, setSeverity] = useState<'all' | Alert['severity']>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const q = useQuery<{ items: Alert[] }>({
    queryKey: ['alerts', severity, unreadOnly],
    queryFn: () => apiGet('/v1/alerts', {
      severity: severity === 'all' ? undefined : severity,
      unread: unreadOnly ? 'true' : undefined,
    }),
  });

  const markRead = useMutation<unknown, Error, string>({
    mutationFn: (id) => apiPatch(`/v1/alerts/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Drift notifications, payer-rule changes, deliverability bounces, denial trends. Click to mark read."
      />

      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)', alignItems: 'flex-end' }}>
        <Select label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
          <option value="all">All</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </Select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', paddingBottom: 12 }}>
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Unread only
        </label>
      </div>

      {q.isLoading && <p>Loading…</p>}
      {q.isError && <Card severity="error" title="Failed to load">{(q.error as Error).message}</Card>}
      {q.data && q.data.items.length === 0 && (
        <Card severity="info" title="Inbox zero">
          <p>No alerts match these filters. Drift detector last ran in the background — fresh signals show up here automatically.</p>
        </Card>
      )}
      {q.data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
          {q.data.items.map((a) => (
            <Card
              key={a.id}
              severity={a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warn' : 'info'}
              title={
                <span style={{ fontWeight: a.read_at ? 400 : 700 }}>
                  {a.read_at ? null : <span style={{
                    display: 'inline-block', marginRight: 'var(--sp-2)',
                    width: 8, height: 8, background: 'var(--fg)',
                  }} aria-label="unread" />}
                  {a.title}
                </span>
              }
              meta={
                <span>
                  {a.severity.toUpperCase()} · {a.type} · {fmt(a.created_at)}
                </span>
              }
            >
              {a.detail && <p>{a.detail}</p>}
              {a.effective_at && (
                <p style={{ fontSize: 13, color: 'var(--fg-secondary)' }}>
                  Effective: {fmt(a.effective_at)}
                </p>
              )}
              {!a.read_at && (
                <Button size="sm" variant="ghost" onClick={() => markRead.mutate(a.id)}>
                  Mark as read
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
