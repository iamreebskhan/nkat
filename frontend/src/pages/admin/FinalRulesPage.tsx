/**
 * Final Rules upload — the "S3 drop folder" UX. Analyst picks a PDF
 * (downloaded from federalregister.gov / cms.gov) + fills in title +
 * effective date, clicks upload. The doc gets a sha256, persists, and
 * appears in the list below.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { Table, type Column } from '../../components/Table';

interface UploadResp {
  source_document_id: string;
  storage_uri: string;
  sha256: string;
  bytes: number;
  duplicate: boolean;
}

interface ListItem {
  id: string;
  title: string;
  document_type: string;
  effective_date: string | null;
  retrieved_at: string;
  content_hash: string;
  storage_uri: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

const MAX_BYTES = 50 * 1024 * 1024;

const DOC_TYPES = [
  { value: 'cms_final_rule', label: 'CMS Final Rule' },
  { value: 'mln_article', label: 'MLN Article' },
  { value: 'cms_pfs', label: 'CMS PFS' },
  { value: 'state_medicaid_manual', label: 'State Medicaid Manual' },
] as const;

export function FinalRulesPage() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState<typeof DOC_TYPES[number]['value']>('cms_final_rule');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<{ name: string; size: number; b64: string; type: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const list = useQuery<{ items: ListItem[] }>({
    queryKey: ['final-rules'],
    queryFn: () => apiGet('/v1/admin/final-rules'),
  });

  const upload = useMutation<UploadResp, Error>({
    mutationFn: () => {
      if (!file) throw new Error('Pick a PDF first.');
      if (!title.trim()) throw new Error('Title is required.');
      return apiPost<UploadResp>('/v1/admin/final-rules', {
        filename: file.name,
        content_base64: file.b64,
        content_type: file.type || 'application/pdf',
        title: title.trim(),
        document_type: docType,
        effective_date: effectiveDate || undefined,
        url: url || undefined,
      });
    },
    onSuccess: () => {
      setFile(null);
      setTitle('');
      setEffectiveDate('');
      setUrl('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['final-rules'] });
    },
  });

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null);
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setFileError(
        `File is ${(f.size / 1_000_000).toFixed(2)} MB; cap is ${MAX_BYTES / 1_000_000} MB.`,
      );
      e.target.value = '';
      return;
    }
    const buf = await f.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    setFile({ name: f.name, size: f.size, b64, type: f.type });
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  }

  const cols: Column<ListItem>[] = [
    {
      header: 'Type',
      cell: (r) => <strong>{r.document_type.replace(/_/g, ' ')}</strong>,
      width: '160px',
    },
    { header: 'Title', cell: (r) => r.title },
    {
      header: 'Effective',
      cell: (r) => (r.effective_date ? r.effective_date.slice(0, 10) : '—'),
      mono: true,
      width: '120px',
    },
    {
      header: 'Hash',
      cell: (r) => <code>{r.content_hash.slice(0, 12)}…</code>,
      mono: true,
      width: '140px',
    },
    {
      header: 'Bytes',
      cell: (r) =>
        typeof r.payload?.bytes === 'number'
          ? `${(r.payload.bytes as number).toLocaleString()}`
          : '—',
      mono: true,
      align: 'right',
      width: '100px',
    },
    {
      header: 'Uploaded',
      cell: (r) => fmt(r.occurred_at),
      mono: true,
      width: '160px',
    },
  ];

  return (
    <>
      <PageHeader
        title="Final Rules"
        subtitle={
          <>
            Drop CMS Final Rules, MLN articles, and state Medicaid manuals
            here. Files are content-hashed + dedup'd platform-wide; the
            extraction queue picks up new documents on its next sweep.
          </>
        }
      />

      <Card title="Upload" severity={fileError ? 'error' : undefined}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 'var(--sp-3)' }}>
          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="CY 2026 Physician Fee Schedule Final Rule"
          />
          <Select
            label="Document type"
            value={docType}
            onChange={(e) => setDocType(e.target.value as typeof docType)}
          >
            {DOC_TYPES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
          <Input
            label="Effective date"
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
        </div>
        <Input
          label="Source URL (optional)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.federalregister.gov/documents/..."
        />
        <div>
          <label
            htmlFor="rule-file"
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--fg-secondary)',
              display: 'block',
              marginBottom: 4,
            }}
          >
            File (PDF, max 50 MB)
          </label>
          <input
            id="rule-file"
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            onChange={onFileChange}
          />
          {file && (
            <p style={{ marginTop: 'var(--sp-2)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {file.name} · {(file.size / 1_000_000).toFixed(2)} MB
            </p>
          )}
          {fileError && (
            <p role="alert" style={{ fontWeight: 700, marginTop: 'var(--sp-2)' }}>
              {fileError}
            </p>
          )}
        </div>
        <Button
          onClick={() => upload.mutate()}
          disabled={!file || !title.trim()}
          loading={upload.isPending}
        >
          Upload
        </Button>
        {upload.isError && (
          <p role="alert" style={{ fontWeight: 700 }}>
            {(upload.error as Error).message}
          </p>
        )}
        {upload.isSuccess && upload.data && (
          <p
            role="status"
            style={{
              fontWeight: 700,
              borderLeft: '6px solid var(--border)',
              paddingLeft: 'var(--sp-2)',
            }}
          >
            {upload.data.duplicate
              ? 'Already on file (deduplicated by sha256).'
              : 'Stored.'}{' '}
            <code>{upload.data.sha256.slice(0, 12)}…</code> · {upload.data.bytes.toLocaleString()} bytes
          </p>
        )}
      </Card>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <h3 style={{ marginBottom: 'var(--sp-3)' }}>Recent uploads (last 200)</h3>
        {list.isLoading && <p>Loading…</p>}
        {list.data && (
          <Table
            rows={list.data.items}
            columns={cols}
            empty="No documents uploaded yet."
          />
        )}
      </div>
    </>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Chunk-based to avoid the call-stack limit on String.fromCharCode for
  // big files (50 MB → 50M args otherwise).
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)),
    );
  }
  return btoa(bin);
}
