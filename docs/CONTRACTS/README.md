# Contract Templates

These are **drafting frameworks**, not legal advice. Every customer contract
gets reviewed by the healthcare regulatory counsel on retainer before
signature. Templates here exist so engineering, GTM, and CSM teams know
what each agreement covers and where the risky clauses live.

## Documents in this folder

| File | Purpose | Counsel review required |
|---|---|---|
| `MSA.md` | Master Services Agreement — commercial terms (scope, fees, term, termination, IP, indemnity, limitation of liability, AKS/Stark/FCA disclaimers) | Yes |
| `BAA.md` | Business Associate Agreement under HIPAA — what PHI we touch, breach notification, sub-processors | Yes |
| `DPA.md` | Data Processing Addendum — GDPR/CPRA/state-privacy obligations (US-only Phase 1 but template anticipates expansion) | Yes |
| `ORDER-FORM.md` | Per-customer order form template — tier, seats, term, price, billing terms | Optional (deal-specific) |

## Workflow

1. Sales fills the **Order Form** with deal terms.
2. Counsel reviews any redlines on **MSA / BAA / DPA**; redlines tracked
   in `docs/CONTRACTS/REDLINES/<customer>.md` for the deal life.
3. CTO + Compliance Lead approves before DocuSign send.
4. Signed PDFs stored in 1Password vault `customers/<customer-id>/`.
5. Termination dates + auto-renewal flags loaded into
   `tracking/contracts.yaml` for CSM renewal motions.

## What goes in `tracking/contracts.yaml`

```yaml
- customer_id: dp-001
  legal_name: Acme Hospice Billing LLC
  msa_signed: 2026-06-01
  msa_term_months: 12
  msa_auto_renew: true
  baa_signed: 2026-06-01
  dpa_signed: 2026-06-01
  order_form_id: of-001
  notice_window_days: 60
  next_renewal_date: 2027-04-02
```

CSM watches `next_renewal_date - notice_window_days` and starts the
renewal conversation per `CUSTOMER-SUCCESS.md`.
