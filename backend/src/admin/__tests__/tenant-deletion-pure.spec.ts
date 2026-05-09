import {
  earliestExecuteAt,
  isReadyForExecution,
  MIN_NOTICE_DAYS,
  validateConfirmationPhrase,
} from '../tenant-deletion-pure';

describe('earliestExecuteAt', () => {
  const NOW = 1_700_000_000_000;

  it('defaults to 30 days from now', () => {
    expect(earliestExecuteAt(NOW).getTime()).toBe(NOW + 30 * 86_400_000);
  });

  it('honors longer requested window', () => {
    expect(earliestExecuteAt(NOW, 60).getTime()).toBe(NOW + 60 * 86_400_000);
  });

  it('REFUSES to shorten below the 30-day floor', () => {
    expect(earliestExecuteAt(NOW, 5).getTime()).toBe(NOW + MIN_NOTICE_DAYS * 86_400_000);
    expect(earliestExecuteAt(NOW, 0).getTime()).toBe(NOW + MIN_NOTICE_DAYS * 86_400_000);
    expect(earliestExecuteAt(NOW, -100).getTime()).toBe(NOW + MIN_NOTICE_DAYS * 86_400_000);
  });
});

describe('validateConfirmationPhrase', () => {
  it.each([
    ['DELETE-TENANT-acme-hospice', 'acme-hospice', true],
    [' DELETE-TENANT-acme-hospice ', 'acme-hospice', true], // trim ok
    ['delete-tenant-acme-hospice', 'acme-hospice', false], // case-sensitive
    ['DELETE-TENANT-acme', 'acme-hospice', false], // wrong slug
    ['', 'acme-hospice', false],
    ['DELETE-TENANT-', 'acme-hospice', false],
  ])('"%s" against slug "%s" → %s', (input, slug, expected) => {
    expect(validateConfirmationPhrase(input, slug)).toBe(expected);
  });

  it('returns false for non-string input', () => {
    expect(validateConfirmationPhrase(null as unknown as string, 'acme')).toBe(false);
    expect(validateConfirmationPhrase(undefined as unknown as string, 'acme')).toBe(false);
    expect(validateConfirmationPhrase(123 as unknown as string, 'acme')).toBe(false);
  });
});

describe('isReadyForExecution', () => {
  const NOW = 1_700_000_000_000;
  const past = new Date(NOW - 1000);
  const future = new Date(NOW + 1000);

  it('ready when status=requested + grace passed', () => {
    expect(isReadyForExecution({ status: 'requested', earliestExecuteAt: past }, NOW)).toBe(true);
  });

  it('ready when status=scheduled + grace passed', () => {
    expect(isReadyForExecution({ status: 'scheduled', earliestExecuteAt: past }, NOW)).toBe(true);
  });

  it('NOT ready when grace not yet elapsed', () => {
    expect(isReadyForExecution({ status: 'requested', earliestExecuteAt: future }, NOW)).toBe(
      false,
    );
  });

  it.each(['executed', 'canceled', 'failed'] as const)(
    'NOT ready when status=%s (terminal/canceled)',
    (s) => {
      expect(isReadyForExecution({ status: s, earliestExecuteAt: past }, NOW)).toBe(false);
    },
  );
});
