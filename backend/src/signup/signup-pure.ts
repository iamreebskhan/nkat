/**
 * Pure helpers for the signup flow — slug derivation, idempotency-key
 * shape, validation that doesn't need a DB.
 */

const SLUG_RE = /[^a-z0-9]+/g;

/**
 * Derive a URL-safe slug from a company name. Strips diacritics,
 * collapses whitespace + punctuation to single hyphens, lowercases.
 * Caller is responsible for uniqueness — append a random suffix on
 * conflict.
 *
 * Examples:
 *   "Acme Hospice Billing, LLC" → "acme-hospice-billing-llc"
 *   "  Multi   Spaced!  "      → "multi-spaced"
 *   ""                          → "tenant"  (fallback so slug is never empty)
 */
export function slugFromCompanyName(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .trim()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return folded || 'tenant';
}

/**
 * Append a 6-character base32 suffix to a slug for collision recovery.
 * Deterministic given a seed (used in tests); random in production.
 */
export function suffixedSlug(base: string, suffix: string): string {
  const safe = suffix.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
  if (!safe) return base;
  return `${base}-${safe}`;
}

/**
 * Validate the trial-days input shape per product policy:
 *   - 0  → no trial
 *   - 1..14 → custom trial (admin-configured promo)
 *   - >14  → rejected (we cap free trial at 14 days, period)
 */
export function clampTrialDays(raw: number | undefined): number {
  if (raw == null) return 0;
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(14, Math.floor(raw));
}
