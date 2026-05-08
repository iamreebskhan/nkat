import { clampTrialDays, slugFromCompanyName, suffixedSlug } from '../signup-pure';

describe('slugFromCompanyName', () => {
  it.each([
    ['Acme Hospice Billing, LLC', 'acme-hospice-billing-llc'],
    ['  Multi   Spaced!  ', 'multi-spaced'],
    ['Tāckle & Co.', 'tackle-co'],
    ['UPPER', 'upper'],
    ['', 'tenant'],
    ['!@#$%', 'tenant'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(slugFromCompanyName(input)).toBe(expected);
  });

  it('caps to 48 chars', () => {
    const long = 'a'.repeat(120);
    expect(slugFromCompanyName(long).length).toBeLessThanOrEqual(48);
  });
});

describe('suffixedSlug', () => {
  it('appends sanitized suffix', () => {
    expect(suffixedSlug('acme', 'X8K!')).toBe('acme-x8k');
  });
  it('returns base when suffix sanitizes empty', () => {
    expect(suffixedSlug('acme', '!!!')).toBe('acme');
  });
  it('caps suffix at 6', () => {
    expect(suffixedSlug('a', 'abcdef0123')).toBe('a-abcdef');
  });
});

describe('clampTrialDays', () => {
  it.each([
    [undefined, 0],
    [-1, 0],
    [0, 0],
    [1, 1],
    [14, 14],
    [30, 14],
    [Number.NaN, 0],
    [3.7, 3],
  ])('%s → %s', (input, expected) => {
    expect(clampTrialDays(input as number | undefined)).toBe(expected);
  });
});
