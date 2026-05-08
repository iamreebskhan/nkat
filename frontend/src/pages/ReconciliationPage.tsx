/**
 * Reconciliation review.
 *
 *   1. Paste / upload doc text + pick a client.
 *   2. POST /v1/redaction/preview to see PHI redacted before commit.
 *   3. Confirm + POST /v1/redaction/ingest — creates a client_doc_upload
 *      with ONLY the redacted text. Originals are never persisted.
 *
 * The diff/finalize loop happens via the existing /v1/reconciliation/*
 * endpoints (rulebook → diff → decisions → finalize) once a doc is
 * ingested — that workflow is its own page in a follow-up.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { PageHeader } from '../components/PageHeader';
import { Select } from '../components/Select';
import styles from './ReconciliationPage.module.css';

interface ClientView {
  id: string;
  name: string;
  npi: string | null;
  primary_state: string | null;
  specialties: string[];
}

interface PreviewResp {
  redacted: string;
  category_counts: Record<string, number>;
  total_redactions: number;
}

interface IngestResp {
  upload_id: string;
  redaction_event_id: string;
  total_redactions: number;
  category_counts: Record<string, number>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Files larger than this are rejected on the FE before reading them
// into a textarea (would freeze the browser). The backend cap is 1 MB.
const MAX_FILE_BYTES = 1_000_000;

export function ReconciliationPage() {
  const [raw, setRaw] = useState('');
  const [filename, setFilename] = useState('rulebook.txt');
  const [clientId, setClientId] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const clients = useQuery<{ items: ClientView[] }>({
    queryKey: ['clients'],
    queryFn: () => apiGet('/v1/clients'),
  });

  const preview = useMutation<PreviewResp, Error, string>({
    mutationFn: (rawText) => apiPost('/v1/redaction/preview', { raw_text: rawText }),
  });

  const ingest = useMutation<IngestResp, Error>({
    mutationFn: () =>
      apiPost<IngestResp>('/v1/redaction/ingest', {
        raw_text: raw,
        client_id: clientId,
        filename,
      }),
  });

  const onPreview = () => {
    setConfirmed(false);
    ingest.reset();
    preview.mutate(raw);
  };

  const canIngest =
    confirmed && UUID_RE.test(clientId) && raw.length > 0 && !ingest.isPending;

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Upload a rule document, preview PHI redaction, then ingest. Originals are never persisted; only the redacted text is stored."
      />

      <div className={styles.cols}>
        <Card title="1. Source document" meta={`${raw.length.toLocaleString()} chars`}>
          <Input
            label="Filename"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="rulebook.txt"
          />
          {clients.data && clients.data.items.length > 0 ? (
            <Select
              label="Client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">— pick a client —</option>
              {clients.data.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.primary_state ? ` (${c.primary_state})` : ''}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              label="Client ID (UUID)"
              value={clientId}
              onChange={(e) => setClientId(e.target.value.trim())}
              placeholder="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
              hint={clients.isLoading ? 'Loading clients…' : 'No clients exist yet — paste an ID manually or seed one.'}
              error={clientId && !UUID_RE.test(clientId) ? 'Must be a UUID' : undefined}
            />
          )}
          <label className="sr-only" htmlFor="raw">Source document text</label>
          <textarea
            id="raw"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Paste rule document text here, or upload a file via the button below."
            rows={20}
            className={styles.ta}
          />
          <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
            <input
              type="file"
              accept=".txt,.md,.csv"
              onChange={async (e) => {
                setFileError(null);
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > MAX_FILE_BYTES) {
                  setFileError(
                    `File is ${(f.size / 1_000_000).toFixed(2)} MB; backend caps at ${MAX_FILE_BYTES / 1_000_000} MB.`,
                  );
                  return;
                }
                setFilename(f.name);
                setRaw(await f.text());
              }}
              aria-label="Upload .txt or .md or .csv"
            />
            <Button onClick={onPreview} disabled={raw.length === 0} loading={preview.isPending}>
              Preview redaction →
            </Button>
          </div>
          {fileError && <p role="alert" style={{ fontWeight: 700 }}>{fileError}</p>}
        </Card>

        <Card
          title="2. Redacted preview"
          meta={preview.data ? `${preview.data.total_redactions} hits` : undefined}
          severity={preview.data && preview.data.total_redactions > 0 ? 'warn' : undefined}
        >
          {!preview.data && !preview.isPending && (
            <p className={styles.muted}>Click <em>Preview redaction</em> to see how the document looks after PHI scrub.</p>
          )}
          {preview.isError && (
            <p role="alert" style={{ fontWeight: 700 }}>{preview.error.message}</p>
          )}
          {preview.data && (
            <>
              <details>
                <summary>Category counts</summary>
                <ul className={styles.counts}>
                  {Object.entries(preview.data.category_counts)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => (
                      <li key={k}>
                        <strong>{k.toUpperCase()}</strong>: {n}
                      </li>
                    ))}
                  {preview.data.total_redactions === 0 && <li>No PHI patterns detected.</li>}
                </ul>
              </details>
              <pre className={styles.preview} aria-label="Redacted preview">{preview.data.redacted}</pre>
              <label style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I have reviewed the redacted version and approve ingestion of the redacted-only copy.
              </label>
              <Button
                variant="primary"
                disabled={!canIngest}
                loading={ingest.isPending}
                onClick={() => ingest.mutate()}
              >
                3. Confirm + ingest
              </Button>
              {ingest.isError && (
                <p role="alert" style={{ fontWeight: 700 }}>{ingest.error.message}</p>
              )}
              {ingest.isSuccess && ingest.data && (
                <p
                  style={{
                    fontWeight: 700,
                    borderLeft: '6px solid var(--border)',
                    paddingLeft: 'var(--sp-2)',
                  }}
                  role="status"
                >
                  Ingested. Upload <code>{ingest.data.upload_id.slice(0, 8)}…</code>{' '}
                  redacted {ingest.data.total_redactions} pattern(s).
                </p>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
