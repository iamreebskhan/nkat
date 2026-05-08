# Master Services Agreement (Template)

> **NOT LEGAL ADVICE.** Healthcare regulatory counsel must review every
> instance before signature. Brackets `[…]` mark required customer-specific
> fields. Sections marked **(non-negotiable)** are core risk allocations
> the company has decided not to vary outside Enterprise tier.

---

This Master Services Agreement (this "**Agreement**") is entered into as
of `[Effective Date]` (the "**Effective Date**") between `[Customer Legal
Name]`, a `[State]` `[entity type]` ("**Customer**"), and `[Company Legal
Name]`, a Delaware corporation ("**Company**").

## 1. Definitions

(Standard SaaS definitions — Service, Documentation, Order Form,
Confidential Information, etc. Counsel template.)

## 2. Service

2.1 **Provision.** Company will provide the Service to Customer in
accordance with the applicable Order Form and the Documentation.

2.2 **Service Levels.** Uptime SLOs are stated per tier in the Order Form.
Service-credit remedies, where applicable, are the **sole and exclusive
remedy** for SLO breach. **(non-negotiable)**

2.3 **Customer responsibilities.** Customer is solely responsible for the
**clinical and billing judgments** Customer makes using the Service.
The Service provides decision-support information; **submission of any
claim and the accuracy thereof remain Customer's responsibility**.
**(non-negotiable — this is the FCA / AKS / billing-judgment moat.)**

## 3. Fees + Payment

3.1 Fees per Order Form. Annual term billed annually in advance unless
otherwise stated.

3.2 Late payment: 1.0% per month, capped at the maximum permitted by law.

3.3 Taxes: Customer pays applicable sales/use/SaaS taxes. Company will
collect via Avalara/Stripe Tax where required.

## 4. Term + Termination

4.1 Initial term per Order Form. Auto-renews for successive 12-month
terms unless either party gives written notice ≥60 days before the end
of the then-current term.

4.2 Termination for convenience: not permitted during Initial Term except
under § 4.5.

4.3 Termination for cause: either party may terminate on 30-day cure
notice for material breach.

4.4 Termination for insolvency: immediate.

4.5 **Design-partner exit window.** During the first 90 days of the
Initial Term, either party may terminate without cause on 30 days'
written notice (mirroring `DESIGN-PARTNER-KIT.md` § "Exit clauses").

4.6 Effect of termination: pre-paid unused fees refunded (pro-rata) only
for termination by Customer for Company's uncured breach. Customer data
exported per § 7. Both parties' confidentiality obligations survive.

## 5. Intellectual Property

5.1 Service IP: Company owns the Service, all improvements, and all
aggregate/derived/anonymized data and metrics derived from Customer's use.

5.2 Customer Data: Customer owns Customer Data. Customer grants Company a
non-exclusive license to process Customer Data **solely to provide the
Service** and, in **de-identified form**, to improve the Service.

5.3 Feedback: Customer-provided feedback may be used by Company without
restriction, royalty-free.

5.4 **AMA CPT Code Set.** Use of CPT codes within the Service is licensed
from the American Medical Association under a separate license. Customer
must accept the AMA's End-User License Agreement (presented in-app)
before viewing CPT descriptors. Customer may not extract or redistribute
CPT descriptors. **(non-negotiable.)**

## 6. Confidentiality

(Mutual; standard 3-year tail; PHI carved out → governed by BAA in §11.)

## 7. Customer Data + Portability

7.1 During the Term, Customer may export at any time:
   (a) `client_rulebook` history (JSON + PDF).
   (b) Audit-log entries for the prior 365 days (CSV).
   (c) 835 ingestion records and denial-event aggregates (CSV).

7.2 Post-termination, Company will retain Customer Data for 30 days for
recovery and then delete (subject to § 7.3). Customer may request
immediate deletion in writing; Company will complete deletion within 30
days.

7.3 **Retention overrides.** PHI within audit logs is retained for the
HIPAA-required minimum of 6 years from creation, in encrypted Object Lock
storage, accessible only via break-glass IAM session.

## 8. Warranties + Disclaimers

8.1 Mutual warranties: authority, no conflicts.

8.2 Company warrants the Service will materially conform to the
Documentation. Sole remedy for breach: re-perform / refund of fees for
the breach period.

8.3 **THE SERVICE IS DECISION-SUPPORT INFORMATION; NO WARRANTY THAT
FOLLOWING IT GUARANTEES PAYMENT, COVERAGE, OR REGULATORY COMPLIANCE.
ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY,
FITNESS FOR PURPOSE, AND NON-INFRINGEMENT, ARE DISCLAIMED TO THE EXTENT
PERMITTED BY LAW.** **(non-negotiable.)**

## 9. Indemnity

9.1 Company indemnifies Customer against third-party IP infringement
claims based on the Service as provided by Company.

9.2 Customer indemnifies Company against third-party claims arising from
Customer's submission of claims to payers, billing decisions, or
non-compliance with applicable healthcare laws.

## 10. Limitation of Liability

10.1 EACH PARTY'S AGGREGATE LIABILITY ≤ THE FEES PAID OR PAYABLE BY
CUSTOMER IN THE 12 MONTHS PRECEDING THE CLAIM. **(non-negotiable.)**

10.2 NO LIABILITY FOR INDIRECT/INCIDENTAL/CONSEQUENTIAL/LOST
PROFITS/REVENUE/DATA. EXCEPTIONS: § 6 confidentiality breach, § 11 PHI
breach (governed by BAA), § 9 IP indemnity, willful misconduct.

## 11. HIPAA

The parties' Business Associate Agreement, attached as **Exhibit B**,
governs PHI handling and breach notification. The BAA controls in any
conflict with this MSA on PHI matters.

## 12. Healthcare Compliance

12.1 **Anti-Kickback / Stark / False Claims Act.** Customer represents
that the fees paid under this Agreement are at fair market value and not
an inducement for any referrals. Customer remains solely responsible for
the accuracy of any claim submitted to a federal healthcare program.
**(non-negotiable.)**

12.2 **Customer-specific compliance.** Customer is responsible for its
own state-licensure, MHPAEA parity, 42 CFR Part 2 consent capture, ABN
processes, and beneficiary protections. Company provides decision support
but is not a covered entity for those obligations.

## 13. Insurance

Company maintains: Cyber liability ≥ $5M/$5M; E&O ≥ $5M/$5M; General
liability ≥ $1M/$2M. Certificates available on written request.

## 14. Miscellaneous

Governing law: Delaware. Disputes: AAA arbitration, Wilmington venue,
single arbitrator, except injunctive relief allowed in court. Force
majeure, assignment (consent for change of control except to affiliate /
acquirer), notice, severability, entire agreement.

---

`[Customer signature block]`

`[Company signature block]`

---

## Internal Review Checklist (do not deliver to customer)

- [ ] Counsel reviewed § 2.3, § 5.4, § 8.3, § 10, § 12 (the
  non-negotiable risk-allocation block).
- [ ] BAA template attached + dates aligned.
- [ ] Order Form: tier, seats, term, fees, billing schedule, SLA.
- [ ] AKS/Stark/FCA disclaimer reviewed against current OIG guidance.
- [ ] Insurance certificates current at signature.
- [ ] If Customer is a Covered Entity (rare for our ICP), confirm BAA flow direction (we are BA to them; they may also be BA to providers).
- [ ] Sales tax nexus configured in Avalara for Customer's state.
