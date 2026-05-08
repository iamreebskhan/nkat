/**
 * Audit log search. Filters: action, target_type, user_id, since/until.
 * Keyset pagination via `cursor` (occurred_at desc).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Table, type Column } from '../../components/Table';

interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  occurred_at: string;
}

interface AuditPage {
  items: AuditRow[];
  next_cursor: string | null;
}

export function AuditLogPage() {
  const [filters, setFilters] = useState<{ action?: string; target_type?: string; user_id?: string; since?: string; until?: string }>({});
  // Page stack — `pages[i]` is the cursor that BEGINS page i. pages[0] is
  // always `null` (first page = no cursor). `page` is the index we're
  // currently viewing. Functional updates everywhere so rapid clicks
  // can't desync the index from the stack length.
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [page, setPage]   = useState(0);
  const cursor = pages[page] ?? null;

  const q = useQuery<AuditPage>({
    queryKey: ['audit-log', filters, cursor],
    queryFn: () => apiGet<AuditPage>('/v1/admin/audit-log', { ...filters, cursor: cursor ?? undefined, limit: 50 }),
  });

  const cols: Column<AuditRow>[] = [
    { header: 'When',   cell: (r) => fmtTime(r.occurred_at), mono: true, width: '160px' },
    { header: 'Action', cell: (r) => <code>{r.action}</code>, width: '220px' },
    { header: 'Target', cell: (r) => r.target_type ? `${r.target_type} · ${r.target_id?.slice(0, 8) ?? '—'}` : '—', mono: true },
    { header: 'User',   cell: (r) => r.user_id?.slice(0, 8) ?? '—', mono: true, width: '110px' },
    { header: 'IP',     cell: (r) => r.ip_address ?? '—', mono: true, width: '120px' },
    {
      header: 'Payload',
      cell: (r) => (
        <details>
          <summary style={{ cursor: 'pointer' }}>{Object.keys(r.payload || {}).length} keys</summary>
          <pre style={{ fontSize: 11, margin: 'var(--sp-2) 0 0', whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(r.payload, null, 2)}
          </pre>
        </details>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Tenant-scoped record of every privileged action. SOC 2 evidence; HIPAA 6-year retention."
      />

      <Card title="Filters">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--sp-3)' }}>
          <Input label="Action"      value={filters.action ?? ''}      onChange={(e) => setFilters({ ...filters, action: e.target.value || undefined })} />
          <Input label="Target type" value={filters.target_type ?? ''} onChange={(e) => setFilters({ ...filters, target_type: e.target.value || undefined })} />
          <Input label="User ID"     value={filters.user_id ?? ''}     onChange={(e) => setFilters({ ...filters, user_id: e.target.value || undefined })} />
          <Input label="Since"       type="datetime-local" value={filters.since ?? ''} onChange={(e) => setFilters({ ...filters, since: e.target.value || undefined })} />
          <Input label="Until"       type="datetime-local" value={filters.until ?? ''} onChange={(e) => setFilters({ ...filters, until: e.target.value || undefined })} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
          <Button onClick={() => { setPages([null]); setPage(0); q.refetch(); }}>Apply</Button>
          <Button variant="ghost" onClick={() => { setFilters({}); setPages([null]); setPage(0); }}>Clear</Button>
        </div>
      </Card>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        {q.isLoading && <p>Loading…</p>}
        {q.isError && <Card severity="error" title="Failed to load">{(q.error as Error).message}</Card>}
        {q.data && (
          <>
            <Table rows={q.data.items} columns={cols} empty="No audit entries match these filters." />
            <nav style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--sp-4)' }}>
              <Button
                variant="secondary"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >← Newer</Button>
              <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--fg-secondary)' }}>
                Page {page + 1}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!q.data.next_cursor}
                onClick={() => {
                  // Capture next_cursor at click time (closure over q.data
                  // is fine — each click reads the response at-render).
                  const nextCursor = q.data?.next_cursor ?? null;
                  if (!nextCursor) return;
                  setPages((prev) => {
                    // If we're on the last known page, append. Otherwise
                    // (user navigated back then forward) reuse the
                    // already-known cursor for the next page.
                    if (page + 1 < prev.length) return prev;
                    return [...prev, nextCursor];
                  });
                  setPage((p) => p + 1);
                }}
              >Older →</Button>
            </nav>
          </>
        )}
      </div>
    </>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
