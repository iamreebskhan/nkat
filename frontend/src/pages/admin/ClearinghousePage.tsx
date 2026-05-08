/**
 * Clearinghouse credentials — per-tenant. Mark's "each customer brings
 * their own Availity account" model. Plaintext is encrypted at rest
 * server-side; this page never reads the plaintext back.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDel, apiGet, apiPost, apiPut } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { Table, type Column } from '../../components/Table';

interface CredRow {
  id: string;
  clearinghouse: 'availity' | 'change_healthcare' | 'waystar';
  display_suffix: string;
  label: string | null;
  last_verified_at: string | null;
  last_verification_status: 'ok' | 'failed' | null;
  last_verification_error: string | null;
  created_at: string;
  updated_at: string;
}

export function ClearinghousePage() {
  const qc = useQueryClient();
  const [clearinghouse, setClearinghouse] =
    useState<CredRow['clearinghouse']>('availity');
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const list = useQuery<{ items: CredRow[] }>({
    queryKey: ['clearinghouse-creds'],
    queryFn: () => apiGet('/v1/admin/clearinghouse/credentials'),
  });

  const upsert = useMutation<unknown, Error>({
    mutationFn: () => {
      setSubmitErr(null);
      // Availity uses { clientId, clientSecret }. Other clearinghouses
      // would have their own shape — gated by the Select above.
      const payload = {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      };
      if (!payload.clientId || !payload.clientSecret) {
        throw new Error('Client ID + client secret are required.');
      }
      return apiPut(`/v1/admin/clearinghouse/credentials/${clearinghouse}`, {
        payload,
        label: label || undefined,
      });
    },
    onSuccess: () => {
      setClientId('');
      setClientSecret('');
      setLabel('');
      qc.invalidateQueries({ queryKey: ['clearinghouse-creds'] });
    },
    onError: (e) => setSubmitErr(e.message),
  });

  const remove = useMutation<unknown, Error, string>({
    mutationFn: (id) => apiDel(`/v1/admin/clearinghouse/credentials/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clearinghouse-creds'] }),
  });

  const test = useMutation<{ ok: boolean; expires_in_sec: number }, Error, string>({
    mutationFn: (id) => apiPost(`/v1/admin/clearinghouse/credentials/${id}/test`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clearinghouse-creds'] }),
  });

  const cols: Column<CredRow>[] = [
    {
      header: 'Clearinghouse',
      cell: (r) => <strong>{r.clearinghouse.replace('_', ' ')}</strong>,
      width: '180px',
    },
    {
      header: 'Identifier',
      cell: (r) => <code>…{r.display_suffix}</code>,
      mono: true,
      width: '120px',
    },
    { header: 'Label', cell: (r) => r.label ?? '—' },
    {
      header: 'Last verified',
      cell: (r) =>
        r.last_verified_at ? (
          <span>
            {fmt(r.last_verified_at)}{' '}
            <strong>{(r.last_verification_status ?? '').toUpperCase()}</strong>
          </span>
        ) : (
          <em>never</em>
        ),
      mono: true,
      width: '220px',
    },
    {
      header: 'Updated',
      cell: (r) => fmt(r.updated_at),
      mono: true,
      width: '160px',
    },
    {
      header: '',
      cell: (r) => (
        <span style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => test.mutate(r.id)}
            disabled={test.isPending}
          >
            Test
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => remove.mutate(r.id)}
            disabled={remove.isPending}
          >
            Remove
          </Button>
        </span>
      ),
      width: '180px',
    },
  ];

  return (
    <>
      <PageHeader
        title="Clearinghouse credentials"
        subtitle={
          <>
            Each tenant brings its own clearinghouse account. Plaintext is
            encrypted at rest with AES-256-GCM and never returned by this
            page. Tested by minting an OAuth token — no actual claim
            traffic flows through the test action.
          </>
        }
      />

      <Card title="Add or replace credentials" severity={submitErr ? 'error' : undefined}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
          <Select
            label="Clearinghouse"
            value={clearinghouse}
            onChange={(e) =>
              setClearinghouse(e.target.value as CredRow['clearinghouse'])
            }
          >
            <option value="availity">Availity</option>
            <option value="change_healthcare">Change Healthcare (Optum)</option>
            <option value="waystar">Waystar</option>
          </Select>
          <Input label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
          <Input
            label="Client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            label="Client Secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            type="password"
          />
        </div>
        <Button onClick={() => upsert.mutate()} loading={upsert.isPending}>
          Save credentials
        </Button>
        {submitErr && (
          <p role="alert" style={{ fontWeight: 700 }}>
            {submitErr}
          </p>
        )}
      </Card>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        {list.isLoading && <p>Loading…</p>}
        {list.isError && (
          <Card severity="error" title="Failed to load">
            {(list.error as Error).message}
          </Card>
        )}
        {test.isError && (
          <Card severity="error" title="Test failed">
            {(test.error as Error).message}
          </Card>
        )}
        {list.data && (
          <Table
            rows={list.data.items}
            columns={cols}
            empty="No clearinghouse credentials configured for this tenant."
          />
        )}
      </div>
    </>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
