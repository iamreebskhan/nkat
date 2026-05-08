/**
 * Public well-known endpoints (RFC 8615).
 *
 *   GET /.well-known/security.txt        — RFC 9116 responsible disclosure
 *   GET /.well-known/wmhmda-policy       — Washington MHMDA Consumer Health
 *                                          Data Privacy Policy (text/markdown)
 *
 * No auth, no rate-limit. These are public by design.
 */
import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

const APP_DOMAIN = process.env.APP_BASE_URL ?? 'https://billing-rules.example.com';
const SECURITY_CONTACT_EMAIL = process.env.SECURITY_CONTACT_EMAIL ?? 'security@example.com';
const PGP_KEY_URL = process.env.SECURITY_PGP_KEY_URL ?? `${APP_DOMAIN}/.well-known/pgp-key.txt`;

@ApiExcludeController()
@Controller('.well-known')
export class WellKnownController {
  /**
   * security.txt per RFC 9116. The Expires field is mandatory; we set
   * it to one year from build time (dynamic — operator should re-deploy
   * before expiry rather than ship a stale file).
   */
  @Get('security.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  securityTxt(): string {
    const expires = new Date();
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
    const lines = [
      `Contact: mailto:${SECURITY_CONTACT_EMAIL}`,
      `Expires: ${expires.toISOString()}`,
      `Encryption: ${PGP_KEY_URL}`,
      `Preferred-Languages: en`,
      `Canonical: ${APP_DOMAIN}/.well-known/security.txt`,
      `Policy: ${APP_DOMAIN}/legal/responsible-disclosure`,
      '',
      '# We treat security reports as P0. Median triage: 1 business day.',
      '# We do not pursue good-faith research; safe-harbor terms in our',
      '# responsible-disclosure policy at the URL above.',
    ];
    return lines.join('\n') + '\n';
  }

  @Get('wmhmda-policy')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  wmhmdaPolicy(): string {
    return WMHMDA_POLICY_MD;
  }
}

const WMHMDA_POLICY_MD = `# Consumer Health Data Privacy Policy
**Washington My Health My Data Act (RCW 19.373)**

_Effective: 2026-05-01. Version: 1.0._

This Consumer Health Data Privacy Policy describes how the operator of
this platform ("we", "us") collects, uses, shares, and secures
"consumer health data" of Washington residents under the Washington
My Health My Data Act (MHMDA).

## What this policy covers

This policy is in addition to our general Privacy Policy. Where our
general Privacy Policy and this MHMDA-specific policy differ for a
Washington resident, this policy applies.

## Categories of consumer health data we collect

We are a business-to-business platform serving healthcare billing
companies. The consumer health data we may process includes, but is
not limited to:

- Claim and billing records associated with a Washington patient
  (procedure codes, diagnosis codes, dates of service, amounts).
- Eligibility and benefit responses (271 EDI) for a Washington patient.
- Audit-log entries that may reference a patient identifier.

We do not collect biometric data, precise geolocation derived from
health-related app interactions, or genetic data.

## How we obtain consumer health data

- From our customer (the billing company), under a Business
  Associate Agreement, when they upload claim files or use our
  pre-flight tooling.
- From clearinghouses we connect to, on our customer's behalf.
- From CMS public APIs (eligibility, fee schedule, NCCI).

## Why we use it

- To provide the billing-rule lookup, pre-flight, and reconciliation
  services our customer has contracted us to deliver.
- To improve the accuracy of our rule library (aggregated, de-identified).
- For required regulatory reporting + audit.

We do **not** sell consumer health data. We do not use consumer
health data for targeted advertising. We do not sell, lease, or
license consumer health data to third parties for their independent
use.

## Sharing

We share consumer health data only:

- With our customer (the billing company that uploaded it).
- With our sub-processors under Data Processing Agreements (cloud
  hosting, observability, customer support tools). A current list is
  available on request.
- With government bodies when required by law and pursuant to valid
  legal process.

## Your rights under MHMDA

Washington residents may:

- **Confirm** whether we are processing your consumer health data and
  **access** that data.
- **Withdraw** consent we previously relied on.
- **Delete** consumer health data we hold about you.

Submit requests via [our DSAR portal](/v1/privacy/dsar) or by emailing
the address in our security.txt. We will verify your identity before
fulfilling and respond within 45 days; we may extend by 45 additional
days when reasonably necessary.

## Storage + security

- All data encrypted at rest (AES-256) and in transit (TLS 1.2+).
- Tenant isolation enforced at the database layer (row-level security).
- Access audited; PHI patterns are redacted from observability logs
  before they leave the security boundary.

## Retention

- Customer-uploaded claim documents: retained per the BAA, deletable
  at any time on the tenant's request via [our DSAR portal](/v1/privacy/dsar).
- Audit-log entries: 6-year HIPAA retention floor; redactable for
  specific entries via the audit-log redaction surface.
- 835 ERA records: 7 years for analytics + denial-trend reporting.

## Updates

We will notify Washington residents of material changes to this policy
30 days before they take effect. Version history lives in our public
GitHub repository for auditability.

## Questions

Contact the address in our [security.txt](/.well-known/security.txt) for
all privacy-related questions, including MHMDA rights requests.
`;
