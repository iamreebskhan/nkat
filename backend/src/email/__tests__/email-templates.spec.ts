import {
  escapeAttr,
  escapeHtml,
  renderDunning,
  renderInvite,
  renderTemplate,
  renderTrialEnding,
  renderWelcome,
} from '../email-templates';

describe('escapeHtml', () => {
  it('escapes the standard 5 metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&"`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&quot;');
  });
});

describe('escapeAttr', () => {
  it('drops control chars + escapes html', () => {
    expect(escapeAttr('a\x07b')).toBe('ab');         // bell stripped
    expect(escapeAttr('a\nb')).toBe('ab');           // newline stripped
    expect(escapeAttr('a"b')).toBe('a&quot;b');      // html escape preserved
  });
});

describe('renderInvite', () => {
  it('escapes org name, includes redeem URL + expiry', () => {
    const r = renderInvite({
      org_name: 'Acme & Co <Hospice>',
      redeem_url: 'https://app.example.com/invite/abc123',
      expires_at: '2026-05-13T09:30:00.000Z',
      inviter_name: 'Alice "the boss"',
    });
    expect(r.subject).toContain('Acme & Co <Hospice>');
    expect(r.html).toContain('Acme &amp; Co &lt;Hospice&gt;');
    expect(r.html).toContain('href="https://app.example.com/invite/abc123"');
    expect(r.html).toContain('2026-05-13 09:30 UTC');
    // Inviter is HTML-escaped in the from-line
    expect(r.html).toContain('Alice &quot;the boss&quot;');
    expect(r.text).toContain('https://app.example.com/invite/abc123');
    expect(r.text).toContain('2026-05-13 09:30 UTC');
  });
});

describe('renderWelcome / renderTrialEnding / renderDunning', () => {
  it('all include the platform footer', () => {
    expect(renderWelcome({ org_name: 'X', app_url: 'https://x' }).html).toContain('do NOT include');
    expect(renderTrialEnding({ org_name: 'X', days_left: 7, manage_url: 'https://x/billing' }).html).toContain('do NOT include');
    expect(renderDunning({ org_name: 'X', manage_url: 'https://x/billing' }).html).toContain('do NOT include');
  });

  it('trial-ending pluralizes correctly', () => {
    expect(renderTrialEnding({ org_name: 'X', days_left: 1, manage_url: 'u' }).subject).toContain('1 day');
    expect(renderTrialEnding({ org_name: 'X', days_left: 7, manage_url: 'u' }).subject).toContain('7 days');
  });
});

describe('renderTemplate dispatches by tag', () => {
  it.each([
    ['invite', { org_name: 'X', redeem_url: 'https://x', expires_at: '2026-01-01T00:00:00Z' }] as const,
    ['welcome', { org_name: 'X', app_url: 'https://x' }] as const,
    ['trial_ending', { org_name: 'X', days_left: 5, manage_url: 'https://x' }] as const,
    ['dunning_past_due', { org_name: 'X', manage_url: 'https://x' }] as const,
  ])('renders %s', (t, args) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = renderTemplate(t as any, args as any);
    expect(r.subject).toBeTruthy();
    expect(r.html).toBeTruthy();
    expect(r.text).toBeTruthy();
  });
});
