/**
 * Email templates — minimal, brand-aware HTML strings.
 *
 * Templates take org branding (display name, primary color, logo URL)
 * + the operation-specific data and return ready-to-send HTML + text.
 *
 * No external template engine — keeps deploy surface small. If we
 * outgrow this, swap to mjml; nothing else changes.
 */

export interface BrandingForEmail {
  displayName: string | null;
  primaryColor: string | null;
  logoUrl: string | null;
}

const DEFAULT_PRIMARY = "#0d9488";
const DEFAULT_DISPLAY = "Pallio";

interface InviteTemplateInput {
  inviteeEmail: string;
  inviterName: string;
  acceptUrl: string;
  expiresAt: string;
  branding: BrandingForEmail;
}

export function inviteEmail(input: InviteTemplateInput): { html: string; text: string; subject: string } {
  const orgName = input.branding.displayName ?? DEFAULT_DISPLAY;
  const primary = input.branding.primaryColor ?? DEFAULT_PRIMARY;
  const expiresHuman = new Date(input.expiresAt).toUTCString();

  const subject = `You've been invited to join ${orgName} on Pallio`;
  const text =
    `${input.inviterName} invited you to join ${orgName} on Pallio.\n\n` +
    `Accept: ${input.acceptUrl}\n\n` +
    `This invite expires ${expiresHuman}.`;

  const html = wrap(
    primary,
    input.branding.logoUrl,
    orgName,
    `
    <p style="font-size: 16px; line-height: 1.6;">
      <strong>${escape(input.inviterName)}</strong> invited you to join
      <strong>${escape(orgName)}</strong> on Pallio.
    </p>
    <p style="font-size: 14px; color: #475569; line-height: 1.6;">
      Pallio is a palliative-care EMR fused with billing intelligence —
      visits, rule lookups, superbills, and denials in one place.
    </p>
    <p style="margin: 32px 0;">
      <a href="${escape(input.acceptUrl)}"
         style="display: inline-block; background: ${primary}; color: white;
                padding: 12px 24px; border-radius: 6px; text-decoration: none;
                font-weight: 600; font-size: 15px;">
        Accept invite
      </a>
    </p>
    <p style="font-size: 12px; color: #64748b;">
      This invite expires ${escape(expiresHuman)}. If you weren't expecting it,
      you can safely ignore this email.
    </p>`,
  );

  return { html, text, subject };
}

interface PayerRuleAlertInput {
  recipientEmail: string;
  payerName: string;
  state: string;
  changedCount: number;
  rulebookUrl: string;
  branding: BrandingForEmail;
}

export function payerRuleAlertEmail(input: PayerRuleAlertInput): { html: string; text: string; subject: string } {
  const orgName = input.branding.displayName ?? DEFAULT_DISPLAY;
  const primary = input.branding.primaryColor ?? DEFAULT_PRIMARY;

  const subject = `${input.payerName} (${input.state}) — ${input.changedCount} rule change${input.changedCount === 1 ? "" : "s"}`;
  const text =
    `${input.payerName} updated ${input.changedCount} rule(s) for ${input.state}.\n\n` +
    `Review: ${input.rulebookUrl}`;

  const html = wrap(
    primary,
    input.branding.logoUrl,
    orgName,
    `
    <p style="font-size: 16px; line-height: 1.6;">
      <strong>${escape(input.payerName)}</strong> updated
      <strong>${input.changedCount}</strong> rule${input.changedCount === 1 ? "" : "s"}
      for <strong>${escape(input.state)}</strong>.
    </p>
    <p style="margin: 24px 0;">
      <a href="${escape(input.rulebookUrl)}"
         style="display: inline-block; background: ${primary}; color: white;
                padding: 10px 18px; border-radius: 6px; text-decoration: none;
                font-weight: 600;">
        Review changes
      </a>
    </p>`,
  );

  return { html, text, subject };
}

function wrap(primary: string, logoUrl: string | null, orgName: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="margin: 0; padding: 24px; background: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="max-width: 560px; width: 100%; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
    <tr>
      <td style="padding: 24px; border-bottom: 2px solid ${primary};">
        ${logoUrl ? `<img src="${escape(logoUrl)}" alt="${escape(orgName)}" style="height: 32px; max-width: 200px;" />` : `<div style="font-size: 18px; font-weight: 700; color: ${primary};">${escape(orgName)}</div>`}
      </td>
    </tr>
    <tr>
      <td style="padding: 32px 24px;">${body}</td>
    </tr>
    <tr>
      <td style="padding: 16px 24px; background: #f8fafc; font-size: 11px; color: #94a3b8; text-align: center;">
        Sent via Pallio · ${escape(orgName)}
      </td>
    </tr>
  </table>
</body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
