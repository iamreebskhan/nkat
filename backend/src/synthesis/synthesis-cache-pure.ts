/**
 * Pure helpers for the per-tenant synthesis content cache.
 *
 *   contentHashFor(provider, request) → 64-char hex SHA-256
 *
 * Distinct from the Phase 22 idempotency cache (which is per-(org_id,
 * client-supplied key)): this cache is per-(org_id, input-content-hash)
 * and saves Bedrock spend on identical re-renders that come without
 * an Idempotency-Key header.
 *
 * What goes into the hash:
 *   - provider name (deterministic vs bedrock — different prompts = different
 *     output, can't share)
 *   - audience (biller / manager / analyst)
 *   - findings array, sort-keyed canonical
 *
 * What does NOT go into the hash:
 *   - request_id (per-request UUID, would defeat caching)
 *   - payer_id / state / product_line / date_of_service — those are
 *     metadata on the lookup, not on the synthesis input. The findings
 *     themselves carry whatever payer/state-specific phrasing matters.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../common/idempotency/idempotency-pure';
import type { SynthesisRequest } from './synthesis-types';

export function contentHashFor(
  provider: string,
  req: SynthesisRequest,
  cacheVersion: number = 1,
): string {
  const h = createHash('sha256');
  h.update(`v${cacheVersion}`);
  h.update('\n');
  h.update(provider);
  h.update('\n');
  h.update(req.audience);
  h.update('\n');
  h.update(canonicalize(req.findings));
  return h.digest('hex');
}
