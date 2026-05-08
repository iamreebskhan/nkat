import { _testing, DEFAULT_REVERIFY_DAYS } from '../reverification.service';

describe('addDays', () => {
  it('adds whole days in UTC', () => {
    const d0 = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
    const d1 = _testing.addDays(d0, 1);
    expect(d1.getUTCFullYear()).toBe(2026);
    expect(d1.getUTCMonth()).toBe(1); // February
    expect(d1.getUTCDate()).toBe(1);
    expect(d1.getUTCHours()).toBe(12);
  });

  it('handles negative days', () => {
    const d0 = new Date(Date.UTC(2026, 4, 1));
    const d1 = _testing.addDays(d0, -1);
    expect(d1.getUTCDate()).toBe(30);
    expect(d1.getUTCMonth()).toBe(3); // April
  });

  it('does not mutate the input', () => {
    const d0 = new Date(Date.UTC(2026, 0, 1));
    const before = d0.getTime();
    _testing.addDays(d0, 90);
    expect(d0.getTime()).toBe(before);
  });
});

describe('DEFAULT_REVERIFY_DAYS', () => {
  it('is 90 per the analyst attestation policy', () => {
    expect(DEFAULT_REVERIFY_DAYS).toBe(90);
  });
});
