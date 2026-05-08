/**
 * Pluggable storage for uploaded source documents.
 *
 * Two backends:
 *   - LocalDiskStorage — writes to `<storageRoot>/<orgId>/<sha>.<ext>`
 *     Fine for dev, single-host deployments, and the analyst-drop-folder
 *     model where one operator uploads PDFs.
 *   - S3Storage (future) — will use the existing SigV4 helper to PUT
 *     the bytes to an S3 bucket. Same Storage interface so callers
 *     don't change.
 *
 * The Storage interface is intentionally minimal: write a buffer +
 * metadata, get back a `storage_uri` string that the rest of the app
 * (source_document.storage_uri column) treats as opaque.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface PutResult {
  storage_uri: string;
  sha256: string;
  bytes: number;
}

export interface Storage {
  /**
   * Persist `data` and return a URI the caller stores in
   * source_document.storage_uri. The same content-hash should ALWAYS
   * resolve to the same URI (deduplicates re-uploads).
   */
  put(args: {
    orgId: string;
    filename: string;
    contentType: string;
    data: Buffer;
  }): Promise<PutResult>;
}

export class LocalDiskStorage implements Storage {
  private readonly root: string;

  constructor(root?: string) {
    this.root = resolve(root ?? process.env.LOCAL_UPLOAD_ROOT ?? './var/uploads');
  }

  async put(args: {
    orgId: string;
    filename: string;
    contentType: string;
    data: Buffer;
  }): Promise<PutResult> {
    const sha = createHash('sha256').update(args.data).digest('hex');
    const ext = guessExtension(args.filename, args.contentType);
    // Two-level fan-out so we don't pile millions of files in one dir.
    const path = join(this.root, args.orgId, sha.slice(0, 2), `${sha}${ext}`);
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    await writeFile(path, args.data);
    return {
      storage_uri: `file://${path.replace(/\\/g, '/')}`,
      sha256: sha,
      bytes: args.data.length,
    };
  }
}

function guessExtension(filename: string, contentType: string): string {
  const m = filename.match(/\.[a-zA-Z0-9]+$/);
  if (m) return m[0].toLowerCase();
  if (contentType === 'application/pdf') return '.pdf';
  if (contentType === 'text/plain') return '.txt';
  if (contentType === 'text/csv') return '.csv';
  return '.bin';
}

/**
 * Pure helper: validate that a base64 string is reasonable, decode it,
 * and enforce a max-size cap. Throws on malformed input or size cap.
 */
export function decodeBase64Bounded(b64: string, maxBytes: number): Buffer {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error('content_base64 is empty');
  }
  // Fast pre-check on encoded size — base64 is 4/3 of the binary size.
  // Reject before allocating the Buffer.
  if (b64.length > Math.ceil(maxBytes * 1.4)) {
    throw new Error(`payload exceeds ${maxBytes} bytes`);
  }
  // Strict check — only valid base64 chars + optional padding.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error('content_base64 is not valid base64');
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > maxBytes) {
    throw new Error(`payload exceeds ${maxBytes} bytes (decoded ${buf.length})`);
  }
  if (buf.length === 0) {
    throw new Error('decoded payload is empty');
  }
  return buf;
}
