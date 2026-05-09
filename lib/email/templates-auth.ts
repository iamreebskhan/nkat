/** Auth-related email templates: password-reset request. */
import type { BrandingForEmail } from "./templates";

const DEFAULT_PRIMARY = "#0d9488";

export function passwordResetEmail(input: {
  to: string;
  resetUrl: string;
  branding: BrandingForEmail;
}): { html: string; text: string; subject: string } {
  const orgName = input.branding.displayName ?? "Pallio";
  const primary = input.branding.primaryColor ?? DEFAULT_PRIMARY;
  const subject = `Reset your ${orgName} password`;
  const text =
    `A password reset was requested for your account.\n\n` +
    `Reset link: ${input.resetUrl}\n\n` +
    `This link expires in 30 minutes. If you didn't request a reset, ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,sans-serif;color:#0f172a;background:#f1f5f9;padding:24px;">
    <table role="presentation" align="center" style="max-width:480px;width:100%;background:white;border-radius:12px;padding:24px;">
      <tr><td>
        <h2 style="font-size:20px;color:${primary};margin:0 0 12px;">Reset your password</h2>
        <p style="font-size:14px;line-height:1.6;color:#475569;">
          A password reset was requested for your ${escape(orgName)} account.
          Click the button below to set a new password. This link expires in 30 minutes.
        </p>
        <p style="margin:24px 0;">
          <a href="${escape(input.resetUrl)}" style="display:inline-block;background:${primary};color:white;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a>
        </p>
        <p style="font-size:12px;color:#64748b;">If you didn't request a reset, ignore this email — your password is unchanged.</p>
      </td></tr>
    </table>
  </body></html>`;
  return { html, text, subject };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
