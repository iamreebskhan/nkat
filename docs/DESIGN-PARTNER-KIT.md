# Design Partner Kit

What we hand to the first 5 design-partner customers and what we ask them
for in return. Use this as the playbook for the GTM motion in months 1–6.

## What "design partner" means here

A paying customer who:

- Signs a Year-1 MSA at **50% standard pricing** of their tier.
- Commits to **2 hours/month** of structured product feedback (1× 60-min product session + async comments on a private roadmap doc).
- Allows their logo + a quote to appear in marketing post-GA.
- Lets us cite anonymized denial-rate-improvement metrics in case studies.
- Gets **direct CTO + product line** for any blocker, with a 24h response SLA on their feedback.

In return, design partners receive Year-2 standard pricing locked at **80% of list** (a 20% perpetual discount).

## ICP for design-partner outreach (first wave)

| Segment | Size | Why it's a fit | Where to find them |
|---|---|---|---|
| Mid-market RCM firms specializing in palliative/hospice/home-health | 20–80 FTE | Tight rule-set + high denial pain; matches Phase 1 + Phase 4 specialty packs | NHPCO membership, NAHC list, LinkedIn |
| Behavioral health billing services | 20–50 FTE | MHPAEA + 42 CFR Part 2 rules are dense; we already have engines for both | NABHP, state BH associations |
| Multi-state RCM serving OH/NC/SC providers | 30–100 FTE | Geographic match to our Medicaid + commercial seed data (Phases 2 + 4) | HFMA local chapters, MGMA |

Avoid for first wave:
- Large hospital systems (Epic-required, long sales cycle).
- Solo billers (low LTV, support drag).
- Specialties we haven't seeded (cardiology, orthopedics) — would force us to do reference-data work mid-pilot.

## Outreach email template

```
Subject: 50% off Year 1 if you'll help us shape billing-rule pre-flight

Hi {first_name},

I'm building {Company} — a billing-rule pre-flight tool that pre-flags
every CARC class against your payer × state × DOS combo with citation-
grounded answers, then measures outcomes from your 835 ERA files. We
think it'll cut your denial rate ~25% in 90 days, but we want to prove
that on real data before we set list pricing.

We're looking for 5 design partners. In exchange for 2 hours/month of
feedback + permission to use your logo post-GA, you get:

  • 50% off Year-1 pricing (standard 11–100 seat tier is $59/seat/mo).
  • 20% off Year-2+ for the life of the relationship.
  • Direct CTO line — 24h SLA on every blocker.
  • Co-developed specialty pack if you focus on {their specialty}.

Worth a 30-min call next week? I have Tue 2pm or Thu 10am ET open.

— {founder}
```

## 60-minute discovery-call agenda

1. **0–10 min: Their pain.** Where does their denial money go? Which payers, states, CARC classes?
2. **10–25 min: Live tool demo.** Run a lookup against a payer × state combo they pick. Show citation panel + confidence + refusal UX. Show denial dashboard with sample 835.
3. **25–40 min: Reconciliation hands-on.** They share-screen one of their rule docs (no PHI); we do live PHI redaction + extraction + diff.
4. **40–50 min: Integration scoping.** Which clearinghouse for 835? SSO? Slack/Teams? Per-customer questions for the IT contact.
5. **50–60 min: Commercial wrap.** Walk through the design-partner agreement: pricing, term, feedback commitment, IP/confidentiality, co-marketing rights, exit. Send DocuSign within 24h.

## Success criteria — what the partnership is measured on (first 90 days)

| Metric | Target | Source |
|---|---|---|
| Denial rate (claim-line %) | -25% vs onboarding baseline | Their 835 feed |
| Pre-flight catch rate per CARC class | >80% on top 5 classes | Cross-ref between our pre-flight log + their 835s |
| Weekly active billers ÷ seats | >70% | App telemetry |
| Lookups per active biller per week | >50 | App telemetry |
| NPS at 90 days | ≥50 | In-app survey |
| Reference-call willingness | yes/no | CSM ask at 90-day review |

If any 3 of these are red at day 60, the design-partner agreement converts to standard pricing with no co-marketing — we don't drag a customer through a relationship that isn't working.

## Welcome email (post-signature)

```
Subject: Welcome to {Company} — your kickoff is {date}

Hi {first_name},

Confirmed for {date}. Pre-call homework (30 min, optional but useful):

  1. Pick 2 payer × state combos you want us to demo against.
  2. Share 1–2 sample 835 ERA files (de-identified or production — we have a BAA).
  3. Share 1 client rule doc you want us to reconcile against authoritative sources.
  4. List your top 5 CPT/HCPCS codes by volume.

What you'll get on the call:
  • Tenant provisioned (admin invite already sent — check spam if you don't see it).
  • SSO config walkthrough if you use Okta / Azure AD / Google.
  • First lookup live against your payer × state.
  • First reconciliation against your rule doc.
  • 835 ingestion configured (clearinghouse webhook or upload).
  • Slack/Teams alert hook configured.

Your direct line for any blocker:
  • Slack: {private channel link}
  • Email: {founder@}
  • SMS: {founder_phone} (use sparingly; 24h SLA on async)

— {founder}
```

## Feedback cadence

| Cadence | Format | Output |
|---|---|---|
| Weekly | Async — `#dp-{partner}` private Slack channel | Open issues, requests, wins |
| Bi-weekly | 30-min product call | Roadmap input + bug triage |
| Monthly | 60-min business review | Health metrics + adoption + denials trend |
| Quarterly | 90-min QBR | Renewal/expansion + roadmap preview |

## Co-marketing terms (post-90 days, if green)

- Logo on `customers` page.
- One quote in launch press + social.
- One 60-min joint webinar (Year 1).
- One conference speaking slot (HIMSS / MGMA / HFMA — we sponsor travel if needed).
- Anonymized case study (denial-rate improvement, $-impact, time-to-value).

## Exit clauses

The design-partner agreement is **terminable for any reason** with 30 days' notice in either direction during the first 90 days. After 90 days, standard MSA termination terms apply. We don't trap people; we want them to stay because the product earns it.

## What design partners do NOT get

- Custom feature builds outside the public roadmap (we'd lose product focus).
- Source-code escrow (Year 2 conversation if they're Enterprise tier).
- Refunds beyond the 30-day exit window.
- Unlimited support outside the SLA — Slack channel is best-effort, not 24×7.

## Internal tracking

Each design partner has a row in `tracking/design-partners.yaml`:

```yaml
- partner_id: dp-001
  company: Acme Hospice Billing
  signed: 2026-06-01
  state: OH
  specialty: hospice
  seats: 18
  primary_contact: { name: "...", email: "..." }
  integration: { ssor: "okta", clearinghouse: "availity" }
  health_score: 82
  status: active
  90day_review: { date: 2026-09-01, denial_rate_change: -0.27, nps: 60 }
```

CSM updates weekly; founders read at the Monday standup.
