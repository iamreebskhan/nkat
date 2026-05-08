/**
 * SnsVerifier — fetches + caches SNS signing certs, verifies signatures
 * against the canonical message string built by `sns-pure.ts`.
 *
 * Cert cache is in-memory, keyed by SigningCertURL (which the AWS spec
 * guarantees is stable per topic per region). 24-hour TTL — re-fetch on
 * key rotation. Cache size bounded at 32 entries.
 *
 * The cert URL is allowlisted by `isAllowedCertUrl` BEFORE we fetch.
 * Algorithm is RSA-SHA1 for SignatureVersion=1, RSA-SHA256 for v2.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { createPublicKey, createVerify } from 'node:crypto';
import { buildCanonicalString, isAllowedCertUrl, type SnsEnvelope } from './sns-pure';

interface CacheEntry {
  pem: string;
  expiresAt: number;
}

@Injectable()
export class SnsVerifier {
  private readonly log = new Logger(SnsVerifier.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries = 32;
  private readonly ttlMs = 24 * 60 * 60 * 1000;

  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly nowFn: () => number;
  constructor(
    @Optional() fetchImpl?: typeof globalThis.fetch,
    @Optional() nowFn?: () => number,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.nowFn = nowFn ?? Date.now;
  }

  /**
   * Verify the envelope. Throws on any failure with a recognizable
   * code; never returns false (callers shouldn't be tempted to retry).
   */
  async verify(envelope: SnsEnvelope): Promise<void> {
    if (!isAllowedCertUrl(envelope.SigningCertURL)) {
      throw new SnsVerifyError('CERT_URL_NOT_ALLOWED', `disallowed cert URL: ${envelope.SigningCertURL}`);
    }
    const algorithm = envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    const pem = await this.getCertPem(envelope.SigningCertURL);
    const canonical = buildCanonicalString(envelope);

    const verifier = createVerify(algorithm);
    verifier.update(canonical, 'utf8');
    const ok = verifier.verify(createPublicKey(pem), envelope.Signature, 'base64');
    if (!ok) {
      throw new SnsVerifyError('SIGNATURE_INVALID', 'SNS signature did not verify');
    }
  }

  private async getCertPem(url: string): Promise<string> {
    const now = this.nowFn();
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > now) return cached.pem;

    const r = await this.fetchImpl(url, { method: 'GET' });
    if (!r.ok) {
      throw new SnsVerifyError('CERT_FETCH_FAILED', `cert fetch ${r.status}`);
    }
    const pem = await r.text();
    if (!/^-----BEGIN CERTIFICATE-----/.test(pem)) {
      throw new SnsVerifyError('CERT_NOT_PEM', 'response was not a PEM cert');
    }
    if (this.cache.size >= this.maxEntries) {
      // Coarse FIFO eviction.
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(url, { pem, expiresAt: now + this.ttlMs });
    this.log.log(`cached SNS cert ${url}`);
    return pem;
  }
}

export class SnsVerifyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SnsVerifyError';
  }
}
