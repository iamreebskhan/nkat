/**
 * SNS notification primitives — pure functions that do everything except
 * the network fetch of the signing cert.
 *
 * AWS SNS signs every message with the topic-region's signing cert; the
 * recipient verifies by:
 *   1. Building the canonical message string (specific field order per
 *      message Type — SubscriptionConfirmation, Notification, etc).
 *   2. Verifying the SigningCertURL points at a real AWS SNS region cert
 *      (we ALLOWLIST the host pattern — never fetch from arbitrary URLs).
 *   3. Fetching the cert, extracting the public key.
 *   4. RSA-SHA1 (legacy) or RSA-SHA256 verify.
 *
 * This module is the pure half: canonicalization + cert-URL allowlist +
 * payload classification. The signature verify itself uses Node crypto +
 * a network fetch, both in `sns.service.ts`.
 *
 * AWS spec: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

import { URL } from 'node:url';
import type { EmailSuppressionReason } from '../database/schema.types';

/** SNS message envelope shape — only the fields we read. */
export interface SnsEnvelope {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  Token?: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
}

/**
 * Build the canonical message string per AWS SNS spec. Field order
 * matters; whitespace is `\n` after each key + value.
 */
export function buildCanonicalString(env: SnsEnvelope): string {
  const fields: Array<[string, string | undefined]> =
    env.Type === 'Notification'
      ? [
          ['Message', env.Message],
          ['MessageId', env.MessageId],
          ['Subject', env.Subject], // included only when present
          ['Timestamp', env.Timestamp],
          ['TopicArn', env.TopicArn],
          ['Type', env.Type],
        ]
      : [
          ['Message', env.Message],
          ['MessageId', env.MessageId],
          ['SubscribeURL', env.SubscribeURL],
          ['Timestamp', env.Timestamp],
          ['Token', env.Token],
          ['TopicArn', env.TopicArn],
          ['Type', env.Type],
        ];
  let out = '';
  for (const [k, v] of fields) {
    if (v == null) continue;
    out += `${k}\n${v}\n`;
  }
  return out;
}

/**
 * AWS SigningCertURL allowlist: the cert must be served from
 * sns.<region>.amazonaws.com (or sns.<region>.amazonaws.com.cn for
 * China regions). We REJECT any other host — fetching arbitrary URLs
 * is the trivial RCE vector here.
 */
export function isAllowedCertUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // Pattern: sns.<region>.amazonaws.com[.cn]
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname)) return false;
  if (!u.pathname.endsWith('.pem')) return false;
  return true;
}

/**
 * SES bounce/complaint message classifier. Returns the suppression
 * reason + an optional `expires_at` (transient bounces auto-clear).
 *
 * AWS docs:
 * https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html
 */
export interface ParsedSesFeedback {
  /** The recipient email(s) the feedback is about. */
  emails: string[];
  reason: EmailSuppressionReason;
  /** Detail string we persist for forensics. */
  detail: string;
  /** When set, suppression auto-clears at this time. */
  expiresAt: Date | null;
}

export function parseSesFeedbackPayload(rawMessage: string, nowMs: number = Date.now()): ParsedSesFeedback | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(rawMessage) as Record<string, unknown>;
  } catch {
    return null;
  }
  const notificationType = (p.notificationType ?? p.eventType) as string | undefined;
  if (!notificationType) return null;

  switch (notificationType) {
    case 'Bounce': {
      const b = (p.bounce ?? {}) as Record<string, unknown>;
      const subType = String(b.bounceType ?? '');
      const recipients = (b.bouncedRecipients ?? []) as Array<{ emailAddress?: string }>;
      const emails = recipients.map((r) => String(r.emailAddress ?? '').toLowerCase()).filter(Boolean);
      if (emails.length === 0) return null;
      const isTransient = subType === 'Transient';
      return {
        emails,
        reason: isTransient ? 'bounce_transient' : 'bounce_permanent',
        detail: `bounceType=${subType} subType=${String(b.bounceSubType ?? '')}`,
        // Transient: auto-clear in 24h. Permanent: never (only break-glass).
        expiresAt: isTransient ? new Date(nowMs + 24 * 3600 * 1000) : null,
      };
    }
    case 'Complaint': {
      const c = (p.complaint ?? {}) as Record<string, unknown>;
      const recipients = (c.complainedRecipients ?? []) as Array<{ emailAddress?: string }>;
      const emails = recipients.map((r) => String(r.emailAddress ?? '').toLowerCase()).filter(Boolean);
      if (emails.length === 0) return null;
      return {
        emails,
        reason: 'complaint',
        detail: `feedbackType=${String(c.complaintFeedbackType ?? 'unknown')}`,
        expiresAt: null, // Complaints never auto-clear.
      };
    }
    default:
      return null;
  }
}

/**
 * Topic-ARN allowlist gate. Even with valid signature + valid cert,
 * we ONLY accept notifications from configured topic ARNs. Stops a
 * cross-account spoof where an attacker creates their own SNS topic +
 * sends us SES-shaped notifications signed with their cert.
 */
export function isAllowedTopicArn(received: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(received);
}
