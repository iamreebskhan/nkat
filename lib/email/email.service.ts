/**
 * Email service — transactional send via Resend.
 *
 * Source: pallio_complete_vision_v3 §6.1 (org "from" identity) +
 * §18.7 (invite + payer-rule-change notifications).
 *
 * Behavior:
 *   - Production: send via Resend API.
 *   - Dev (no RESEND_API_KEY): log the email to stdout, return a fake id.
 *     Lets local devs work the invite flow end-to-end without a key.
 *
 * Per-org "from" identity: callers supply the org_branding row's
 * email_from_name + email_from_address. Resend requires the sending
 * domain to be verified — a not-yet-verified domain falls back to
 * the platform default.
 */
import { Resend } from "resend";

import { env } from "@/lib/env";

let _resend: Resend | null = null;

function client(): Resend | null {
  if (_resend) return _resend;
  const key = env().RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  fromAddress?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  id: string;
  delivered: boolean;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const platformFrom = env().EMAIL_FROM_ADDRESS;
  const from = composeFrom({
    name: input.fromName,
    address: input.fromAddress ?? platformFrom,
    fallbackAddress: platformFrom,
  });

  const r = client();
  if (!r) {
    // Dev fallback — log to stdout. The link in the body still works.
    console.info("[email:dev]", JSON.stringify({
      to: input.to, from, subject: input.subject,
      preview: input.text ?? input.html.slice(0, 200),
    }));
    return { id: `dev_${Date.now()}`, delivered: false };
  }

  const result = await r.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
  });

  if (result.error) {
    throw new Error(`Email send failed: ${result.error.message}`);
  }
  return { id: result.data?.id ?? "", delivered: true };
}

function composeFrom(args: { name?: string; address: string; fallbackAddress: string }): string {
  const addr = isVerifiedDomain(args.address) ? args.address : args.fallbackAddress;
  return args.name ? `${quoteName(args.name)} <${addr}>` : addr;
}

/**
 * In a real deploy this would query Resend's domain-verification API.
 * Phase 8: trust the address is verified. Phase 7's deploy runbook
 * pre-verifies the org's custom domain in Resend.
 */
function isVerifiedDomain(_address: string): boolean {
  return true;
}

function quoteName(name: string): string {
  // Strip CR/LF + double quotes; everything else is fine.
  return `"${name.replace(/[\r\n"]+/g, " ").trim()}"`;
}
