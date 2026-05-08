/**
 * AWS Signature Version 4 (SigV4) — pure-function HMAC-SHA256 signer.
 *
 * The full spec is at:
 *   https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 *
 * Why our own SigV4 (not the SDK):
 *   - We need ONE outbound surface (SES SendEmail). The full
 *     `@aws-sdk/client-sesv2` is ~2MB; SigV4 is ~80 lines.
 *   - The signer is pure: takes inputs, returns headers. Zero state,
 *     no provider chain, no retry logic. Easier to reason about + test.
 *   - The exact same module signs against any SigV4 service later
 *     (Comprehend Medical, S3, etc) without an SDK swap.
 *
 * Caller responsibilities:
 *   - Provide `accessKeyId`, `secretAccessKey`, optional `sessionToken`
 *     (from the ECS task IAM role at runtime).
 *   - Provide region + service.
 *   - Provide method, path, query, headers, body.
 *
 * The signer mutates nothing on the caller's input — it returns a NEW
 * headers object the caller passes to fetch().
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignArgs {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Includes path; e.g. '/v2/email/outbound-emails'. */
  path: string;
  /** Query string WITHOUT leading '?'. May be empty. */
  query?: string;
  headers: Record<string, string>;
  body: string; // UTF-8 string body (or '' for GET)
  region: string;
  service: string; // e.g. 'ses'
  credentials: SigV4Credentials;
  /** Inject for tests; defaults to new Date(). */
  now?: Date;
}

export interface SignedHeaders {
  /** Final headers to pass to fetch — includes X-Amz-Date + Authorization. */
  headers: Record<string, string>;
  /** ISO 8601 basic format used in the signature, exposed for tests. */
  amzDate: string;
}

export function signRequest(args: SignArgs): SignedHeaders {
  const now = args.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  // Step 1 — canonicalize headers. We REQUIRE Host (the caller passes
  // it). We add x-amz-date and x-amz-security-token (when present).
  const reqHeaders: Record<string, string> = {
    ...args.headers,
    'x-amz-date': amzDate,
  };
  if (args.credentials.sessionToken) {
    reqHeaders['x-amz-security-token'] = args.credentials.sessionToken;
  }
  // Lowercase header names; trim values.
  const lowered: Array<[string, string]> = Object.entries(reqHeaders).map(
    ([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')],
  );
  lowered.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = lowered.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lowered.map(([k]) => k).join(';');

  // Step 2 — payload hash.
  const payloadHash = sha256Hex(args.body);

  // Step 3 — canonical request.
  const canonicalRequest = [
    args.method,
    canonicalUri(args.path),
    canonicalQuery(args.query ?? ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Step 4 — string to sign.
  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Step 5 — derive signing key.
  const kDate = hmac(`AWS4${args.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, args.service);
  const kSigning = hmac(kService, 'aws4_request');

  // Step 6 — final signature.
  const signature = hmac(kSigning, stringToSign).toString('hex');

  // Step 7 — Authorization header.
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${args.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const out: Record<string, string> = {
    ...reqHeaders,
    Authorization: authorization,
  };
  return { headers: out, amzDate };
}

// ----------------------------------------------------------------------------
// Helpers (exported for tests).
// ----------------------------------------------------------------------------

export function formatAmzDate(d: Date): string {
  // Format: YYYYMMDDTHHMMSSZ. e.g. 20260506T093015Z.
  const iso = d.toISOString(); // 2026-05-06T09:30:15.000Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function canonicalUri(path: string): string {
  // Don't re-encode '/' separators; do percent-encode every other
  // character per RFC 3986. AWS SigV4 expects double-encoding for some
  // services (S3 doesn't, SES does NOT either) — we follow the
  // single-encode default that matches SES + most services.
  return (path || '/')
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

export function canonicalQuery(query: string): string {
  if (!query) return '';
  const pairs = query.split('&').filter(Boolean).map((kv) => {
    const eq = kv.indexOf('=');
    const k = eq >= 0 ? kv.slice(0, eq) : kv;
    const v = eq >= 0 ? kv.slice(eq + 1) : '';
    return [decodeURIComponent(k), decodeURIComponent(v)] as const;
  });
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
