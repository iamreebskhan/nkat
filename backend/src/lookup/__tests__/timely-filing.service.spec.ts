import { daysBetween } from '../services/timely-filing.service';

describe('daysBetween', () => {
  it('returns 0 for the same day', () => {
    expect(daysBetween(new Date('2026-04-15'), new Date('2026-04-15'))).toBe(0);
  });

  it('counts whole days correctly', () => {
    expect(daysBetween(new Date('2026-04-15'), new Date('2026-05-15'))).toBe(30);
  });

  it('handles year-spanning ranges', () => {
    expect(daysBetween(new Date('2025-12-15'), new Date('2026-12-15'))).toBe(365);
  });

  it('returns negative for filing_date before DOS (should never happen, but defined)', () => {
    expect(daysBetween(new Date('2026-04-15'), new Date('2026-04-01'))).toBeLessThan(0);
  });
});
