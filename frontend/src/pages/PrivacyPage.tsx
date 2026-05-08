/**
 * Consumer-privacy hub. Shows applicable notices for the active
 * tenant's primary state + lets the user file a DSAR. Lists this
 * tenant's open DSARs at the bottom (admin view).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { PageHeader } from '../components/PageHeader';
import { Select } from '../components/Select';
import { Table, type Column } from '../components/Table';

interface Notice {
  regime: string;
  version: string;
  title: string;
  body: string;
  actions: { label: string; href?: string; kind: string }[];
}

interface DsarRow {
  id: string;
  regime: string;
  request_type: string;
  status: 'received' | 'verified' | 'fulfilled' | 'rejected' | 'expired';
  due_at: string;
  received_at: string;
  fulfilled_at: string | null;
  subject_email: string | null;
  rejection_reason: string | null;
}

const STATES = ['WA','CA','CO','TX','VA','OH','NC','SC','NY','MA','OR','MI','PA','MN','MO','TN','IL','GA','AZ'];

export function PrivacyPage() {
  const qc = useQueryClient();
  const [state, setState] = useState('WA');
  const [regime, setRegime] = useState('wmhmda');
  const [reqType, setReqType] = useState<'access' | 'deletion' | 'portability' | 'correction' | 'opt_out_sale' | 'opt_out_targeted_advertising' | 'limit_sensitive_use'>('deletion');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const notices = useQuery<{ state: string; notices: Notice[] }>({
    queryKey: ['privacy-notices', state],
    queryFn: () => apiGet(`/v1/privacy/notices/${state}`),
  });

  const dsars = useQuery<{ items: DsarRow[] }>({
    queryKey: ['dsars'],
    queryFn: () => apiGet('/v1/privacy/dsar'),
  });

  const file = useMutation<{ id: string; due_at: string }, Error>({
    mutationFn: () => apiPost('/v1/privacy/dsar', {
      regime,
      request_type: reqType,
      subject_email: email || undefined,
      subject_name: name || undefined,
      notes: notes || undefined,
    }),
    onSuccess: () => {
      setEmail(''); setName(''); setNotes('');
      qc.invalidateQueries({ queryKey: ['dsars'] });
    },
  });

  const cols: Column<DsarRow>[] = [
    { header: 'Status',  cell: (r) => <strong>{r.status.toUpperCase()}</strong>, width: '110px' },
    { header: 'Regime',  cell: (r) => <code>{r.regime}</code>, mono: true, width: '120px' },
    { header: 'Type',    cell: (r) => r.request_type, width: '180px' },
    { header: 'Subject', cell: (r) => r.subject_email ?? '—' },
    { header: 'Due',     cell: (r) => fmt(r.due_at), mono: true, width: '160px' },
    { header: 'Received',cell: (r) => fmt(r.received_at), mono: true, width: '160px' },
  ];

  return (
    <>
      <PageHeader
        title="Privacy"
        subtitle="State-privacy notices that apply to your operation, plus DSAR (Data Subject Access Request) intake. 45-day fulfillment SLA."
      />

      <Card title="State notices">
        <Select label="Resident state" value={state} onChange={(e) => setState(e.target.value)}>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        {notices.data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', marginTop: 'var(--sp-3)' }}>
            {notices.data.notices.map((n) => (
              <article key={n.regime} style={{
                border: '1px solid var(--border-subtle)',
                padding: 'var(--sp-3) var(--sp-4)',
              }}>
                <h4 style={{ margin: '0 0 var(--sp-2)' }}>{n.title}</h4>
                <small style={{ color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {n.regime} · v{n.version}
                </small>
                <p style={{ marginTop: 'var(--sp-3)' }}>{n.body}</p>
                {n.actions.length > 0 && (
                  <ul style={{ margin: 'var(--sp-2) 0 0', paddingLeft: 'var(--sp-5)' }}>
                    {n.actions.map((a, i) => (
                      <li key={i}>
                        {a.href ? <a href={a.href}>{a.label}</a> : a.label}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
      </Card>

      <Card title="File a DSAR" severity="warn" >
        <p>The 45-day clock starts at <em>received</em>. Tenant admins respond via <strong>Admin → Audit log</strong> (filter <code>privacy.dsar_*</code>).</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--sp-3)' }}>
          <Select label="Regime" value={regime} onChange={(e) => setRegime(e.target.value)}>
            <option value="wmhmda">WMHMDA (WA)</option>
            <option value="ccpa">CCPA (CA)</option>
            <option value="cpa_co">CPA (CO)</option>
            <option value="tdpsa_tx">TDPSA (TX)</option>
            <option value="vcdpa_va">VCDPA (VA)</option>
            <option value="general">General</option>
          </Select>
          <Select label="Request type" value={reqType} onChange={(e) => setReqType(e.target.value as typeof reqType)}>
            <option value="access">Access</option>
            <option value="deletion">Deletion</option>
            <option value="portability">Portability</option>
            <option value="correction">Correction</option>
            <option value="opt_out_sale">Opt out of sale</option>
            <option value="opt_out_targeted_advertising">Opt out of targeted advertising</option>
            <option value="limit_sensitive_use">Limit sensitive use</option>
          </Select>
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Verification context, reason, etc." />
        <Button onClick={() => file.mutate()} loading={file.isPending}>Submit DSAR</Button>
        {file.isSuccess && (
          <p style={{ fontWeight: 700, borderLeft: '6px solid var(--border)', paddingLeft: 'var(--sp-2)' }}>
            Filed. Due {fmt(file.data.due_at)}.
          </p>
        )}
        {file.isError && <p role="alert" style={{ fontWeight: 700 }}>{(file.error as Error).message}</p>}
      </Card>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <h3 style={{ marginBottom: 'var(--sp-3)' }}>Open DSARs (this tenant)</h3>
        {dsars.data && <Table rows={dsars.data.items} columns={cols} empty="No DSARs filed against this tenant." />}
      </div>
    </>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
