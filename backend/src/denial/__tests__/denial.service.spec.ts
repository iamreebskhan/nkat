import { daysAgo } from '../denial.service';

describe('daysAgo', () => {
  it('returns midnight UTC of N days ago', () => {
    const d = daysAgo(30);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });

  it('is monotonically older for larger N', () => {
    const a = daysAgo(7);
    const b = daysAgo(30);
    expect(b.getTime()).toBeLessThan(a.getTime());
  });

  it('returns today midnight for N=0', () => {
    const d0 = daysAgo(0);
    const today = new Date();
    expect(d0.getUTCFullYear()).toBe(today.getUTCFullYear());
    expect(d0.getUTCMonth()).toBe(today.getUTCMonth());
    expect(d0.getUTCDate()).toBe(today.getUTCDate());
  });
});
