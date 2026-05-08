/**
 * SCIM bearer-token management. Plaintext is shown ONCE on create.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDel, apiGet, apiPost } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Table, type Column } from '../../components/Table';

interface TokenRow {
  id: string;
  display_suffix: string;
  description: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface CreateResp {
  id: string;
  token: string;
  display_suffix: string;
  created_at: string;
  expires_at: string | null;
}

export function ScimTokenPage() {
  const qc = useQueryClient();
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt]     = useState('');
  const [justCreated, setJustCreated] = useState<CreateResp | null>(null);

  const list = useQuery<{ items: TokenRow[] }>({
    queryKey: ['scim-tokens'],
    queryFn: () => apiGet('/v1/admin/scim/tokens'),
  });

  const create = useMutation<CreateResp, Error>({
    mutationFn: () =>
      apiPost('/v1/admin/scim/tokens', {
        description: description || undefined,
        expires_at: expiresAt || undefined,
      }),
    onSuccess: (data) => {
      setJustCreated(data);
      setDescription('');
      setExpiresAt('');
      qc.invalidateQueries({ queryKey: ['scim-tokens'] });
    },
  });

  const revoke = useMutation<unknown, Error, string>({
    mutationFn: (id) => apiDel(`/v1/admin/scim/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scim-tokens'] }),
  });

  const cols: Column<TokenRow>[] = [
    { header: 'Suffix',     cell: (r) => <code>…{r.display_suffix}</code>, mono: true, width: '120px' },
    { header: 'Description',cell: (r) => r.description ?? '—' },
    { header: 'Created',    cell: (r) => fmt(r.created_at), mono: true, width: '160px' },
    { header: 'Expires',    cell: (r) => r.expires_at ? fmt(r.expires_at) : 'never', mono: true, width: '160px' },
    { header: 'Last used',  cell: (r) => r.last_used_at ? fmt(r.last_used_at) : '—', mono: true, width: '160px' },
    { header: 'Status',     cell: (r) => r.revoked_at ? <strong>REVOKED</strong> : 'active', width: '100px' },
    {
      header: '',
      cell: (r) => r.revoked_at ? null : (
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            // Once revoked there's no undo — any IdP using this token
            // starts failing immediately. Two-step confirm to stop a
            // misclick from taking down a customer's SCIM sync.
            const ok = window.confirm(
              `Revoke SCIM token …${r.display_suffix}?\n\n` +
              `This is immediate and cannot be undone. Any IdP using ` +
              `this token will receive 401 on its next request.`,
            );
            if (ok) revoke.mutate(r.id);
          }}
          disabled={revoke.isPending}
        >
          Revoke
        </Button>
      ),
      width: '110px',
    },
  ];

  return (
    <>
      <PageHeader
        title="SCIM tokens"
        subtitle="Bearer tokens for IdP user-lifecycle provisioning (Okta / Azure AD / Entra). Plaintext is shown only at creation."
      />

      {justCreated && (
        <Card severity="warn" title="New token created — copy it now" meta={`…${justCreated.display_suffix}`}>
          <p><strong>This is the only time we will show the plaintext token.</strong></p>
          <pre style={{
            background: 'var(--bg-inverse)',
            color: 'var(--fg-inverse)',
            padding: 'var(--sp-3)',
            wordBreak: 'break-all',
            fontFamily: 'var(--font-mono)',
            fontSize: 14,
          }}>
            {justCreated.token}
          </pre>
          <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
            <Button onClick={() => navigator.clipboard.writeText(justCreated.token)}>Copy</Button>
            <Button variant="ghost" onClick={() => setJustCreated(null)}>I've saved it — dismiss</Button>
          </div>
        </Card>
      )}

      <Card title="Create token" >
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--sp-3)' }}>
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Okta production" />
          <Input label="Expires (optional)" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
        <div>
          <Button onClick={() => create.mutate()} loading={create.isPending}>Create token</Button>
          {create.isError && <p style={{ marginTop: 'var(--sp-2)', fontWeight: 700 }}>{(create.error as Error).message}</p>}
        </div>
      </Card>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        {list.isLoading && <p>Loading…</p>}
        {list.data && <Table rows={list.data.items} columns={cols} empty="No SCIM tokens. Create one above." />}
      </div>
    </>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
