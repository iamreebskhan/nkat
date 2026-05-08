/**
 * Lookup — the daily driver. Cascade filters at top (state, payer
 * line, product line, date of service); a multi-line claim editor;
 * a result panel with severity-stripe cards per finding.
 *
 * The result-card severity is shown via left-border weight only — no
 * color. Citations open in a side rail.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiPost } from '../api/client';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { Select } from '../components/Select';
import styles from './LookupPage.module.css';

interface ClaimLine {
  code: string;
  modifiers: string;        // edited as comma-string, split before send
  pos: string;
  units: string;
}

interface LookupRequest {
  payer_id: string;
  state: string;
  product_line: string;
  date_of_service: string;
  lines: { code: string; modifiers?: string[]; pos?: string; units?: number }[];
  diagnoses?: string[];
  provider_taxonomy?: string;
}

interface LookupFinding {
  severity: 'critical' | 'warning' | 'info' | 'ok';
  code?: string;
  carc?: string;
  category: string;
  message: string;
  recommendation?: string;
  citations?: { source_url?: string; quote?: string; effective_date?: string }[];
}

interface LookupResponse {
  overall_severity: 'critical' | 'warning' | 'info' | 'ok';
  findings: LookupFinding[];
  request_echo?: unknown;
}

const STATES = ['OH','NC','SC','CA','TX','FL','NY','WA','CO','VA','PA','IL','GA','MI','MA','MN','OR','AZ','MO','TN'];
const PRODUCT_LINES = [
  'medicare_ffs','medicare_advantage','medicaid_ffs','medicaid_mco',
  'commercial','exchange_qhp','workers_comp_state',
  'institutional_hospital','institutional_hospice','institutional_home_health','asc',
];

export function LookupPage() {
  const [state, setState]               = useState('OH');
  const [payerId, setPayerId]           = useState('a0000000-0000-4000-8000-000000000301');
  const [productLine, setProductLine]   = useState('medicare_ffs');
  const [dos, setDos]                   = useState(today());
  const [diagnoses, setDiagnoses]       = useState('Z51.5');
  const [taxonomy, setTaxonomy]         = useState('');
  const [lines, setLines]               = useState<ClaimLine[]>([
    { code: '99497', modifiers: '', pos: '11', units: '1' },
  ]);

  const submit = useMutation<LookupResponse, Error, LookupRequest>({
    mutationFn: (body) => apiPost<LookupResponse>('/v1/lookup', body),
  });

  const onRun = (e: React.FormEvent) => {
    e.preventDefault();
    const body: LookupRequest = {
      payer_id: payerId,
      state,
      product_line: productLine,
      date_of_service: dos,
      lines: lines
        .filter((l) => l.code.trim().length > 0)
        .map((l) => ({
          code: l.code.trim().toUpperCase(),
          modifiers: l.modifiers ? l.modifiers.split(',').map((m) => m.trim()).filter(Boolean) : undefined,
          pos: l.pos.trim() || undefined,
          units: l.units ? Number(l.units) : undefined,
        })),
      diagnoses: diagnoses.split(',').map((d) => d.trim()).filter(Boolean),
      provider_taxonomy: taxonomy.trim() || undefined,
    };
    submit.mutate(body);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Lookup</h1>
        <p className={styles.sub}>
          Pre-flight a claim against payer rules + NCCI + LCD/NCD + COB. Findings
          are returned with citations.
        </p>
      </header>

      <form className={styles.form} onSubmit={onRun} aria-label="Lookup form">
        <div className={styles.cascade}>
          <Select label="State" value={state} onChange={(e) => setState(e.target.value)}>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Input label="Payer ID (UUID)" value={payerId} onChange={(e) => setPayerId(e.target.value.trim())} />
          <Select label="Product line" value={productLine} onChange={(e) => setProductLine(e.target.value)}>
            {PRODUCT_LINES.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          <Input label="Date of service" type="date" value={dos} onChange={(e) => setDos(e.target.value)} />
          <Input label="Diagnoses (ICD-10, comma)" value={diagnoses} onChange={(e) => setDiagnoses(e.target.value)} placeholder="Z51.5, I50.32" />
          <Input label="Provider taxonomy" value={taxonomy} onChange={(e) => setTaxonomy(e.target.value)} placeholder="(optional)" />
        </div>

        <fieldset className={styles.lines}>
          <legend className={styles.legend}>Service lines</legend>
          <div className={styles.linesHeader}>
            <span>Code</span>
            <span>Modifiers</span>
            <span>POS</span>
            <span>Units</span>
            <span aria-label="actions" />
          </div>
          {lines.map((l, idx) => (
            <div key={idx} className={styles.lineRow}>
              <Input value={l.code} onChange={(e) => updateLine(idx, { code: e.target.value }, lines, setLines)} placeholder="99497" />
              <Input value={l.modifiers} onChange={(e) => updateLine(idx, { modifiers: e.target.value }, lines, setLines)} placeholder="25" />
              <Input value={l.pos} onChange={(e) => updateLine(idx, { pos: e.target.value }, lines, setLines)} placeholder="11" />
              <Input value={l.units} onChange={(e) => updateLine(idx, { units: e.target.value }, lines, setLines)} type="number" min={1} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                disabled={lines.length === 1}
                aria-label={`Remove line ${idx + 1}`}
              >×</Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setLines([...lines, { code: '', modifiers: '', pos: '11', units: '1' }])}
          >+ Add line</Button>
        </fieldset>

        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={submit.isPending}>Run lookup</Button>
          <span className={styles.shortcut}>Submit on <kbd>⌘</kbd>+<kbd>Enter</kbd></span>
        </div>
        <SubmitOnCmdEnter onTrigger={() => {
          // Build a synthetic-but-valid FormEvent shim — onRun only
          // needs `preventDefault`. Avoids the unsafe KeyboardEvent
          // → React.FormEvent cast.
          const submitter = { preventDefault: () => {} } as unknown as React.FormEvent;
          onRun(submitter);
        }} />
      </form>

      {submit.isError && (
        <Card severity="error" title="Lookup failed">
          <p><strong>{(submit.error as { code?: string }).code ?? 'ERROR'}</strong></p>
          <p className={styles.muted}>{submit.error.message}</p>
        </Card>
      )}

      {submit.data && <ResultPanel data={submit.data} />}
    </div>
  );
}

function ResultPanel({ data }: { data: LookupResponse }) {
  const counts = useMemo(() => bucketize(data.findings), [data]);
  return (
    <section className={styles.results} aria-label="Lookup results">
      <header className={styles.resultsHeader}>
        <h2>Findings</h2>
        <SeverityStripe overall={data.overall_severity} counts={counts} />
      </header>

      {data.findings.length === 0 ? (
        <Card severity="info" title="Clean">
          <p>No findings. The claim passes our pre-flight checks for this payer + DOS combination.</p>
        </Card>
      ) : (
        <div className={styles.findings}>
          {data.findings.map((f, i) => (
            <FindingCard key={i} finding={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function FindingCard({ finding }: { finding: LookupFinding }) {
  return (
    <Card
      severity={severityToCard(finding.severity)}
      title={
        <span>
          <span className={styles.findingSev} data-sev={finding.severity}>{finding.severity.toUpperCase()}</span>
          {finding.category}
          {finding.code && <span className={styles.codeBadge}>{finding.code}</span>}
          {finding.carc && <span className={styles.codeBadge}>CARC {finding.carc}</span>}
        </span>
      }
    >
      <p>{finding.message}</p>
      {finding.recommendation && (
        <p className={styles.rec}>
          <strong>Recommendation: </strong>
          {finding.recommendation}
        </p>
      )}
      {finding.citations && finding.citations.length > 0 && (
        <details className={styles.citations}>
          <summary>{finding.citations.length} citation(s)</summary>
          <ul>
            {finding.citations.map((c, i) => (
              <li key={i}>
                {c.source_url ? <a href={c.source_url} target="_blank" rel="noreferrer">{c.source_url}</a> : null}
                {c.quote && <blockquote>"{c.quote}"</blockquote>}
                {c.effective_date && <span className={styles.muted}>effective {c.effective_date}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function SeverityStripe({ overall, counts }:
  { overall: LookupResponse['overall_severity'], counts: Record<string, number> }) {
  return (
    <div className={styles.stripe} role="img" aria-label={`Overall ${overall}`}>
      <span className={styles.stripeOverall} data-sev={overall}>{overall.toUpperCase()}</span>
      <span>·</span>
      <span>{counts.critical ?? 0}<small> critical</small></span>
      <span>{counts.warning  ?? 0}<small> warning</small></span>
      <span>{counts.info     ?? 0}<small> info</small></span>
    </div>
  );
}

function bucketize(findings: LookupFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

function severityToCard(s: LookupFinding['severity']): 'info' | 'warn' | 'error' {
  if (s === 'critical') return 'error';
  if (s === 'warning')  return 'warn';
  return 'info';
}

function updateLine(
  i: number,
  patch: Partial<ClaimLine>,
  lines: ClaimLine[],
  set: (l: ClaimLine[]) => void,
): void {
  const next = [...lines];
  next[i] = { ...next[i], ...patch };
  set(next);
}

function today(): string {
  const d = new Date();
  const y = d.getFullYear(); const m = `${d.getMonth() + 1}`.padStart(2, '0'); const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Listens for Cmd/Ctrl + Enter anywhere in the document and submits. */
function SubmitOnCmdEnter({ onTrigger }: { onTrigger: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onTrigger();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onTrigger]);
  return null;
}
