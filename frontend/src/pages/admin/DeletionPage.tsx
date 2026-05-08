/**
 * Tenant data deletion (MSA § 7). Requires the operator to type the
 * exact `DELETE-TENANT-<orgSlug>` confirmation phrase. 30-day grace
 * is server-enforced. Cancellable while pending or scheduled.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDel, apiGet, apiPost } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';

interface CurrentNone { status: 'none' }
interface CurrentRow {
  id: string;
  status: 'requested' | 'scheduled' | 'executed' | 'canceled' | 'failed';
  earliest_execute_at: string;
  executed_at: string | null;
  canceled_at: string | null;
  failure_reason: string | null;
  reason: string | null;
  retain_audit_log: boolean;
  created_at: string;
}
type Current = CurrentNone | CurrentRow;

interface AuthMe {
  orgId: string | null;
  userId: string | null;
  role: string | null;
  orgSlug: string | null;
  orgName: string | null;
}

export function DeletionPage() {
  const qc = useQueryClient();
  const [phrase, setPhrase]    = useState('');
  const [reason, setReason]    = useState('');
  const [retain, setRetain]    = useState(true);
  const [days, setDays]        = useState('30');

  const me = useQuery<AuthMe>({
    queryKey: ['auth-me'],
    queryFn: () => apiGet('/v1/auth/me'),
    staleTime: 60_000,
  });
  const expectedPhrase = me.data?.orgSlug ? `DELETE-TENANT-${me.data.orgSlug}` : null;
  const phraseValid = expectedPhrase !== null && phrase === expectedPhrase;

  const cur = useQuery<Current>({
    queryKey: ['tenant-deletion'],
    queryFn: () => apiGet('/v1/admin/tenant/delete'),
  });

  const request = useMutation<{ id: string; status: string; earliest_execute_at: string; org_slug: string }, Error>({
    mutationFn: () => apiPost('/v1/admin/tenant/delete', {
      confirmation_phrase: phrase,
      reason: reason || undefined,
      notice_days: Number(days),
      retain_audit_log: retain,
    }),
    onSuccess: () => {
      setPhrase(''); setReason('');
      qc.invalidateQueries({ queryKey: ['tenant-deletion'] });
    },
  });

  const cancel = useMutation<unknown, Error, string>({
    mutationFn: (id) => apiDel(`/v1/admin/tenant/delete/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-deletion'] }),
  });

  const pending = cur.data && (cur.data as CurrentRow).status &&
    ['requested', 'scheduled'].includes((cur.data as CurrentRow).status);

  return (
    <>
      <PageHeader
        title="Tenant data deletion"
        subtitle="MSA § 7 — request immediate deletion in writing. We will complete deletion within 30 days. Audit log retained by default for HIPAA 6-year requirement."
      />

      {cur.data && (cur.data as CurrentRow).id && (
        <Card
          severity={pending ? 'warn' : 'info'}
          title={`Current request — ${(cur.data as CurrentRow).status.toUpperCase()}`}
          meta={`#${(cur.data as CurrentRow).id.slice(0, 8)}`}
        >
          <DefList rows={[
            ['Earliest execute', fmt((cur.data as CurrentRow).earliest_execute_at)],
            ['Created',          fmt((cur.data as CurrentRow).created_at)],
            ['Reason',           (cur.data as CurrentRow).reason ?? '—'],
            ['Retain audit log', String((cur.data as CurrentRow).retain_audit_log)],
            ['Executed at',      (cur.data as CurrentRow).executed_at ? fmt((cur.data as CurrentRow).executed_at!) : '—'],
            ['Canceled at',      (cur.data as CurrentRow).canceled_at ? fmt((cur.data as CurrentRow).canceled_at!) : '—'],
            ['Failure reason',   (cur.data as CurrentRow).failure_reason ?? '—'],
          ]} />
          {pending && (
            <Button
              variant="danger"
              onClick={() => cancel.mutate((cur.data as CurrentRow).id)}
              loading={cancel.isPending}
            >
              Cancel deletion request
            </Button>
          )}
        </Card>
      )}

      {(!cur.data || (cur.data as CurrentNone).status === 'none' || !pending) && (
        <Card severity="error" title="Request deletion">
          <p>
            <strong>This is destructive.</strong> Type the exact confirmation phrase below.
            The 30-day floor is server-enforced; admins cannot shorten it.
          </p>
          <Input
            label="Confirmation phrase"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={expectedPhrase ?? 'DELETE-TENANT-<your-org-slug>'}
            autoComplete="off"
            spellCheck={false}
            hint={
              expectedPhrase
                ? `Type exactly: ${expectedPhrase}`
                : 'Loading expected phrase…'
            }
            error={
              phrase.length > 0 && !phraseValid
                ? 'Does not match the expected phrase yet.'
                : undefined
            }
            trailing={phrase.length > 0 ? (phraseValid ? '✓' : '✕') : undefined}
          />
          <Input
            label="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Customer-initiated request via support ticket #1234"
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
            <Input
              label="Notice days (≥ 30)"
              type="number"
              min={30}
              max={180}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <label style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--sp-2)', paddingBottom: 12 }}>
              <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
              Retain audit log (HIPAA 6yr)
            </label>
          </div>
          <Button
            variant="danger"
            onClick={() => {
              const ok = window.confirm(
                `This will request DELETION of all tenant data for ${me.data?.orgName ?? 'this org'} ` +
                `after a 30-day server-enforced grace window. ` +
                `Are you sure?`,
              );
              if (ok) request.mutate();
            }}
            disabled={!phraseValid}
            loading={request.isPending}
          >
            Submit deletion request
          </Button>
          {request.isError && (
            <p role="alert" style={{ fontWeight: 700 }}>{(request.error as Error).message}</p>
          )}
        </Card>
      )}
    </>
  );
}

function DefList({ rows }: { rows: [string, string][] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 'var(--sp-2) var(--sp-4)', margin: 0 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--fg-secondary)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</dt>
          <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
