import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskStorage, decodeBase64Bounded } from '../storage';

describe('LocalDiskStorage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'br-storage-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a file and returns a stable storage_uri keyed by sha256', async () => {
    const s = new LocalDiskStorage(root);
    const data = Buffer.from('hello world');
    const r = await s.put({
      orgId: '11111111-1111-4111-8111-111111111111',
      filename: 'rule.pdf',
      contentType: 'application/pdf',
      data,
    });
    expect(r.bytes).toBe(11);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.storage_uri.startsWith('file://')).toBe(true);
    const onDisk = r.storage_uri.replace('file://', '');
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk).equals(data)).toBe(true);
  });

  it('produces the same storage_uri for identical content (dedup)', async () => {
    const s = new LocalDiskStorage(root);
    const a = await s.put({ orgId: 'a-org', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('x') });
    const b = await s.put({ orgId: 'a-org', filename: 'y.pdf', contentType: 'application/pdf', data: Buffer.from('x') });
    expect(a.storage_uri).toBe(b.storage_uri);
    expect(a.sha256).toBe(b.sha256);
  });

  it('namespaces by org', async () => {
    const s = new LocalDiskStorage(root);
    const a = await s.put({ orgId: 'org-a', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('x') });
    const b = await s.put({ orgId: 'org-b', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('x') });
    expect(a.storage_uri).not.toBe(b.storage_uri);
    expect(a.storage_uri).toContain('/org-a/');
    expect(b.storage_uri).toContain('/org-b/');
  });

  it('infers extension from filename', async () => {
    const s = new LocalDiskStorage(root);
    const r = await s.put({
      orgId: 'o',
      filename: 'final-rule-CMS-1789-FC.PDF',
      contentType: 'application/octet-stream',
      data: Buffer.from('x'),
    });
    expect(r.storage_uri.endsWith('.pdf')).toBe(true);
  });

  it('falls back to .pdf when filename has no extension and content-type is pdf', async () => {
    const s = new LocalDiskStorage(root);
    const r = await s.put({
      orgId: 'o',
      filename: 'no-extension',
      contentType: 'application/pdf',
      data: Buffer.from('x'),
    });
    expect(r.storage_uri.endsWith('.pdf')).toBe(true);
  });
});

describe('decodeBase64Bounded', () => {
  it('decodes valid base64', () => {
    const buf = decodeBase64Bounded(Buffer.from('hello').toString('base64'), 1000);
    expect(buf.toString()).toBe('hello');
  });

  it('rejects non-base64 strings', () => {
    expect(() => decodeBase64Bounded('not base64 ✕', 1000)).toThrow(/not valid base64/);
  });

  it('rejects empty input', () => {
    expect(() => decodeBase64Bounded('', 1000)).toThrow(/empty/);
  });

  it('rejects oversized input pre-decode (encoded length check)', () => {
    const tooBig = 'A'.repeat(100_000);
    expect(() => decodeBase64Bounded(tooBig, 1024)).toThrow(/exceeds/);
  });

  it('rejects oversized input post-decode', () => {
    // Just at the encoded-size pre-check limit, but binary-decoded above maxBytes.
    const data = Buffer.alloc(2048, 0x41).toString('base64');
    expect(() => decodeBase64Bounded(data, 1024)).toThrow(/exceeds/);
  });

  it('rejects when decoded payload is empty', () => {
    // base64 of an empty string — the regex catches "" but technically "==" alone is
    // weird input. Confirm we still throw on a strictly empty decode.
    expect(() => decodeBase64Bounded('====', 1000)).toThrow(/empty|not valid/);
  });
});
