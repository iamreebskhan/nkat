/**
 * Denial dashboard — top CARC by count + $ impact, last 30/90/365d.
 * Pure-CSS bar chart in greyscale (no charting library).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { Select } from '../components/Select';
import { Table, type Column } from '../components/Table';
import styles from './DenialsPage.module.css';

interface DenialBucket {
  carc: string;
  rarc: string | null;
  count: number;
  dollar_impact: number;
  preflight_caught_count: number;
  description?: string;
}

interface DenialResponse {
  period_start: string;
  period_end: string;
  total_denials: number;
  total_dollar_impact: number;
  preflight_catch_rate: number; // 0..1
  buckets: DenialBucket[];
}

export function DenialsPage() {
  const [days, setDays] = useState('30');
  const q = useQuery<DenialResponse>({
    queryKey: ['denials', days],
    queryFn: () => apiGet('/v1/denials/summary', { days }),
  });

  const cols: Column<DenialBucket>[] = [
    { header: 'CARC',         cell: (r) => <strong>{r.carc}</strong>, mono: true, width: '90px' },
    { header: 'RARC',         cell: (r) => r.rarc ?? '—', mono: true, width: '90px' },
    { header: 'Description',  cell: (r) => r.description ?? '—' },
    { header: 'Count',        cell: (r) => r.count.toLocaleString(), align: 'right', width: '100px' },
    { header: '$ impact',     cell: (r) => `$${r.dollar_impact.toLocaleString()}`, align: 'right', width: '140px' },
    {
      header: 'Pre-flight catch %',
      cell: (r) => r.count > 0 ? `${Math.round((r.preflight_caught_count / r.count) * 100)}%` : '—',
      align: 'right',
      width: '160px',
    },
  ];

  return (
    <>
      <PageHeader
        title="Denials"
        subtitle="Trends from your 835 ERA ingestion. Pre-flight catch rate is the % of denials our rules warned about before submission."
      />

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <Select label="Period" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last 365 days</option>
        </Select>
      </div>

      {q.isLoading && <p>Loading…</p>}
      {q.isError && <Card severity="error" title="Failed to load">{(q.error as Error).message}</Card>}
      {q.data && (
        <>
          <div className={styles.kpis}>
            <KPI label="Total denials" value={q.data.total_denials.toLocaleString()} />
            <KPI label="$ impact" value={`$${q.data.total_dollar_impact.toLocaleString()}`} />
            <KPI label="Pre-flight catch" value={`${Math.round(q.data.preflight_catch_rate * 100)}%`} />
            <KPI label="Top class" value={q.data.buckets[0]?.carc ?? '—'} sub={q.data.buckets[0]?.description} />
          </div>

          <Card title="By CARC class">
            <BarChart
              data={q.data.buckets.slice(0, 10).map((b) => ({
                label: b.carc,
                value: b.count,
                hint: b.description,
              }))}
              maxLabel="Count"
            />
          </Card>

          <div style={{ marginTop: 'var(--sp-5)' }}>
            <Table rows={q.data.buckets} columns={cols} empty="No denials in this period." />
          </div>
        </>
      )}
    </>
  );
}

function KPI({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiLabel}>{label}</span>
      <strong className={styles.kpiValue}>{value}</strong>
      {sub && <span className={styles.kpiSub}>{sub}</span>}
    </div>
  );
}

function BarChart({ data, maxLabel }: { data: { label: string; value: number; hint?: string }[]; maxLabel: string }) {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0) || 1;
  return (
    <div role="img" aria-label={`Bar chart, ${maxLabel}`}>
      {data.map((d, i) => (
        <div key={i} className={styles.barRow}>
          <span className={styles.barLabel}>{d.label}</span>
          <span className={styles.barTrack}>
            <span
              className={styles.barFill}
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }}
              title={d.hint}
            />
          </span>
          <span className={styles.barValue}>{d.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
