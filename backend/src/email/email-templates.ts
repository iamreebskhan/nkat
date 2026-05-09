/**
 * Email templates — pure functions that take typed args and return
 * `{ subject, html, text }`. No PHI is passed into templates by
 * convention; the typed `args` shape per template defines the contract.
 *
 * HTML is hand-written so we don't pull a templating engine into the
 * runtime. The output is plain enough that any mail client renders it
 * the same way; the text fallback is what most billing-shop screens
 * read anyway.
 */
import type { EmailTemplate } from './email-types';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface InviteArgs {
  org_name: string;
  redeem_url: string;
  expires_at: string; // ISO
  inviter_name?: string | null;
}

export interface WelcomeArgs {
  org_name: string;
  app_url: string;
}

export interface TrialEndingArgs {
  org_name: string;
  days_left: number;
  manage_url: string;
}

export interface DunningArgs {
  org_name: string;
  manage_url: string;
}

/**
 * Footer is per-message because the unsubscribe URL embeds the
 * recipient's signed token. EmailService renders + injects.
 */
export interface FooterMeta {
  unsubscribe_url?: string;
}

function footerHtml(m: FooterMeta = {}): string {
  const unsub = m.unsubscribe_url
    ? `<p style="color:#888;font-size:12px;margin-top:8px">` +
      `Don't want these emails? <a href="${escapeAttr(m.unsubscribe_url)}">Unsubscribe</a>.` +
      `</p>`
    : '';
  return (
    '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0"/>' +
    '<p style="color:#888;font-size:12px">' +
    'This message is from your billing-rules platform. If you did not expect it, ' +
    'reply to let us know — do NOT include any patient identifiers in your reply.' +
    '</p>' +
    unsub
  );
}

function footerText(m: FooterMeta = {}): string {
  const unsub = m.unsubscribe_url ? `\nUnsubscribe: ${m.unsubscribe_url}\n` : '';
  return (
    '\n--\nIf you did not expect this message, reply to let us know.\n' +
    'Do NOT include any patient identifiers in your reply.' +
    unsub +
    '\n'
  );
}

export function renderInvite(a: InviteArgs, meta: FooterMeta = {}): RenderedEmail {
  const subject = `You're invited to ${a.org_name}`;
  const expiresHuman = formatExpiry(a.expires_at);
  const fromLine = a.inviter_name ? ` from ${escapeHtml(a.inviter_name)}` : '';
  const html =
    `<p>Hi —</p>` +
    `<p>You've been invited${fromLine} to administer the <strong>${escapeHtml(a.org_name)}</strong> tenant on the platform.</p>` +
    `<p style="margin:24px 0"><a href="${escapeAttr(a.redeem_url)}" style="background:#0a7;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Accept invitation</a></p>` +
    `<p>The link expires on <strong>${escapeHtml(expiresHuman)}</strong>.</p>` +
    footerHtml(meta);
  const text =
    `Hi —\n\nYou've been invited${a.inviter_name ? ` from ${a.inviter_name}` : ''} to administer the "${a.org_name}" tenant on the platform.\n\n` +
    `Accept your invitation: ${a.redeem_url}\n\n` +
    `The link expires on ${expiresHuman}.${footerText(meta)}`;
  return { subject, html, text };
}

export function renderWelcome(a: WelcomeArgs, meta: FooterMeta = {}): RenderedEmail {
  return {
    subject: `Welcome to ${a.org_name}`,
    html:
      `<p>Welcome to <strong>${escapeHtml(a.org_name)}</strong> on the billing-rules platform.</p>` +
      `<p>Sign in any time at <a href="${escapeAttr(a.app_url)}">${escapeHtml(a.app_url)}</a>.</p>` +
      footerHtml(meta),
    text: `Welcome to ${a.org_name} on the billing-rules platform.\n\nSign in any time at ${a.app_url}.${footerText(meta)}`,
  };
}

export function renderTrialEnding(a: TrialEndingArgs, meta: FooterMeta = {}): RenderedEmail {
  return {
    subject: `Your ${a.org_name} trial ends in ${a.days_left} day${a.days_left === 1 ? '' : 's'}`,
    html:
      `<p>Your trial for <strong>${escapeHtml(a.org_name)}</strong> ends in ${a.days_left} day${a.days_left === 1 ? '' : 's'}.</p>` +
      `<p>Add a payment method to keep access uninterrupted: <a href="${escapeAttr(a.manage_url)}">manage billing</a>.</p>` +
      footerHtml(meta),
    text:
      `Your trial for "${a.org_name}" ends in ${a.days_left} day${a.days_left === 1 ? '' : 's'}.\n\n` +
      `Manage billing: ${a.manage_url}${footerText(meta)}`,
  };
}

export function renderDunning(a: DunningArgs, meta: FooterMeta = {}): RenderedEmail {
  return {
    subject: `Action required: payment failed on ${a.org_name}`,
    html:
      `<p>We were unable to process the latest invoice for <strong>${escapeHtml(a.org_name)}</strong>.</p>` +
      `<p>Please update your payment method to avoid service interruption: ` +
      `<a href="${escapeAttr(a.manage_url)}">manage billing</a>.</p>` +
      footerHtml(meta),
    text:
      `We were unable to process the latest invoice for "${a.org_name}".\n\n` +
      `Please update your payment method to avoid service interruption: ${a.manage_url}${footerText(meta)}`,
  };
}

export type RenderArgsFor<T extends EmailTemplate> = T extends 'invite'
  ? InviteArgs
  : T extends 'welcome'
    ? WelcomeArgs
    : T extends 'trial_ending'
      ? TrialEndingArgs
      : T extends 'dunning_past_due'
        ? DunningArgs
        : never;

export function renderTemplate<T extends EmailTemplate>(
  t: T,
  args: RenderArgsFor<T>,
  meta: FooterMeta = {},
): RenderedEmail {
  switch (t) {
    case 'invite':
      return renderInvite(args as InviteArgs, meta);
    case 'welcome':
      return renderWelcome(args as WelcomeArgs, meta);
    case 'trial_ending':
      return renderTrialEnding(args as TrialEndingArgs, meta);
    case 'dunning_past_due':
      return renderDunning(args as DunningArgs, meta);
    default: {
      const exhaustive: never = t;
      throw new Error(`unknown template: ${exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(s: string): string {
  // For href="..." attribute values, we additionally drop control chars.
  return escapeHtml(s).replace(/[\x00-\x1f\x7f]/g, '');
}

function formatExpiry(iso: string): string {
  // "2026-05-13 09:30 UTC" — keep the timezone obvious.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yy}-${mm}-${dd} ${hh}:${mi} UTC`;
}
