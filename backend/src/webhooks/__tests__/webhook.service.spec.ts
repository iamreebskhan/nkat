import { _backoffForTesting } from '../webhook.service';

describe('webhook backoff', () => {
  const { nextReadyAt, BACKOFF_SEQUENCE_MS } = _backoffForTesting;
  const now = new Date('2026-04-15T00:00:00Z');

  it('attempt 1 (immediate retry) → 0ms', () => {
    expect(nextReadyAt(0, now)?.getTime()).toBe(now.getTime() + BACKOFF_SEQUENCE_MS[0]);
  });

  it('attempt 2 → +1m', () => {
    expect(nextReadyAt(1, now)?.getTime()).toBe(now.getTime() + 60_000);
  });

  it('attempt 5 → +1h', () => {
    expect(nextReadyAt(4, now)?.getTime()).toBe(now.getTime() + 3_600_000);
  });

  it('beyond the schedule clamps to the last bucket', () => {
    const last = BACKOFF_SEQUENCE_MS[BACKOFF_SEQUENCE_MS.length - 1];
    expect(nextReadyAt(50, now)?.getTime()).toBe(now.getTime() + last);
  });

  it('schedule is monotonic', () => {
    for (let i = 1; i < BACKOFF_SEQUENCE_MS.length; i++) {
      expect(BACKOFF_SEQUENCE_MS[i]).toBeGreaterThanOrEqual(BACKOFF_SEQUENCE_MS[i - 1]);
    }
  });
});
