# Business Associate Agreement (Template)

> **NOT LEGAL ADVICE.** Counsel must review every instance.

This BAA is incorporated into the MSA between `[Customer]` ("**Covered
Entity**" or "**Business Associate** as Customer's role may be) and
`[Company]` ("**Business Associate**" or "**Subcontractor**"). Capitalized
terms not defined here have the meanings in 45 C.F.R. §§ 160.103, 164.501.

## 1. Permitted Uses + Disclosures of PHI

Business Associate may use or disclose PHI only:

(a) to perform the Service for Customer (lookup, reconciliation, 835
ingestion, dashboards, alerts);

(b) for Business Associate's proper management and administration;

(c) as required by law;

(d) **in de-identified form (per 45 C.F.R. § 164.514) for product
improvement, eval-set construction, and aggregate analytics**.

## 2. Prohibited Uses

Business Associate will not:

(a) use or disclose PHI other than as permitted herein;

(b) sell PHI;

(c) use PHI for marketing without specific written authorization;

(d) re-identify de-identified data.

## 3. Safeguards

Business Associate maintains the administrative, physical, and technical
safeguards required by the HIPAA Security Rule:

- Encryption at rest (KMS, separate keys per data class).
- Encryption in transit (TLS 1.3 only).
- Postgres Row-Level Security on every tenant-scoped table; app role has
  `NOBYPASSRLS`; break-glass role gated by SSO + MFA + ticket.
- Audit logging on all PHI access; logs retained 6 years.
- Defense-in-depth PHI scrubbing in observability pipeline.
- Annual workforce HIPAA training.
- Annual penetration test; SOC 2 Type 2.

## 4. Reporting

Business Associate will report to Customer:

(a) any **Breach of Unsecured PHI** within **5 business days** of
discovery (sooner if practicable). Notification will include the
information required by 45 C.F.R. § 164.410(c).

(b) any Security Incident not constituting a Breach: aggregated quarterly,
unless a specific incident materially affects Customer's data.

(c) any use or disclosure not permitted by this BAA, promptly upon
discovery.

## 5. Subcontractors

Business Associate will execute a HIPAA-compliant BAA with every
Subcontractor that creates, receives, maintains, or transmits PHI on
Business Associate's behalf, including but not limited to:

- AWS (RDS, ECS, Bedrock, S3, KMS, Secrets Manager) — under the AWS BAA.
- Datadog (log + APM telemetry) — under Datadog HIPAA BAA.
- Comprehend Medical (PHI redaction) — under AWS BAA.
- Stripe (payments only — does not process PHI; BAA optional).
- Vanta (compliance evidence — no PHI).

Updated sub-processor list available at [link]; Customer may object to
new sub-processors in writing within 30 days of notice; if not resolved
within 60 days, Customer may terminate per MSA § 4.3.

## 6. Access, Amendment, Accounting

Business Associate will, within 30 days of Customer's written request:

(a) make PHI in a Designated Record Set available to Customer or the
individual per 45 C.F.R. § 164.524;

(b) make amendments to PHI per 45 C.F.R. § 164.526;

(c) provide an accounting of disclosures per 45 C.F.R. § 164.528.

## 7. Inspection

On reasonable advance notice and at most once per 12 months (more
frequently if there is a Breach), Business Associate will make available
its SOC 2 Type 2 report, HIPAA risk assessment, and pen-test summary for
Customer's review under reasonable confidentiality terms.

## 8. Termination

(a) Customer may terminate this BAA + the MSA on 30-day cure notice for
Business Associate's material breach of this BAA.

(b) On termination, Business Associate will return or destroy all PHI
not retained for HIPAA-required audit purposes (see MSA § 7.3).

## 9. Survival

Sections 4, 6, and 7 survive termination as to PHI retained for audit
purposes.

## 10. 42 C.F.R. Part 2 (SUD)

If Customer transmits Substance Use Disorder records subject to 42 C.F.R.
Part 2, Customer must (i) capture proper TPO consent before transmission;
(ii) flag such records on the way in; and (iii) acknowledge that the
Service refuses to process Part 2 PHI absent active consent on file.
**(non-negotiable.)**

## 11. State-Law Add-Ons

Where applicable, Business Associate complies with:

- Washington My Health My Data Act (consumer-health-data privacy).
- California CMIA + CPRA.
- Texas TDPSA / Virginia VCDPA / Connecticut CTDPA / Colorado CPA / etc.
  comprehensive consumer privacy laws to the extent they apply to
  Business Associate's processing.

---

`[Signatures]`
