# Customer Success Playbook

How we onboard, retain, and grow customers. Optimized for the ICP from
plan v3: mid-market RCM firms (20–200 employees) and in-house billing
teams at provider groups (10–50 providers).

## Tiers

| Tier | Seats | Price/seat/mo | Onboarding | Support SLA | Uptime | Best for |
|---|---|---|---|---|---|---|
| **Solo** | 1 | $79 | Self-serve | Email, 24h business-hours | 99.5% | Independent billers, 14-day trial |
| **Team** | 2–10 | $69 | 30-min kickoff (self-serve docs) | Email, 24h business-hours | 99.5% | Small billing co, single specialty |
| **Org** | 11–100 | $59 | 60-min kickoff + first-rulebook reconciliation hands-on | In-app chat + email, 4h business-hours | 99.9% | Mid-market RCM, multi-specialty |
| **Enterprise** | 100+ | Custom | Dedicated CSM, white-glove migration | 1h 24×7, dedicated CSM | 99.95% w/ credits | Large RCM, hospital systems, white-label |

Free tier: 10 lookups/day, 1 state, no reconciliation, no 835 ingestion. Conversion target 5–10% to Solo/Team within 30 days.

## Onboarding (Org tier — 60 minutes)

### Pre-call (T-3 days)
- CSM sends welcome email: agenda + pre-work checklist (sample rule doc, 1–2 sample 835 files, list of payers + states + specialties).
- Provision tenant org; create admin user; send invite.
- Confirm SSO config if applicable (SAML/OIDC). SCIM 2.0 setup for Org/Enterprise.

### The kickoff call (60 min)
1. **0–10 min: Goals review.** What does success look like in 90 days? (Typical: 25%+ denial-rate reduction in chosen specialty.)
2. **10–25 min: First lookup walkthrough** with the customer's real payer/state/code combo. Show the citation panel + confidence + refusal UX. Make sure they see "covered / not covered / varies / unknown" semantics.
3. **25–45 min: Reconciliation hands-on.** Customer uploads a real client rule doc; we walk through PHI redaction preview → extraction → diff list → finalize. End with a saved rulebook.
4. **45–55 min: 835 ingestion setup.** Either (a) upload a sample 835 file or (b) configure clearinghouse webhook (Availity/Change Healthcare/Waystar). Show the denial dashboard with first-run data.
5. **55–60 min: Wrap.** Schedule 30-day review. Share knowledge base + Loom library. Add to `#customer-success` Slack channel for async questions (Org+).

### Week 1–4 cadence
- **Day 3**: CSM checks login activity, lookup volume. If <10 lookups by day 3 → reach out, find friction.
- **Week 1**: First weekly digest email with denial trends (if 835s flowing).
- **Week 2**: Second rulebook reconciliation. By now the customer should be self-sufficient.
- **Week 4**: 30-day review. Share denial-trend chart vs onboarding baseline. Identify expansion opportunities (more states, more specialties, more seats).

## Health scoring

Per-tenant weekly score (0–100):

| Signal | Weight | Reason |
|---|---|---|
| Weekly active billers ÷ seats | 30% | Adoption — the #1 churn predictor |
| Lookups per active biller per week | 20% | Engagement depth |
| 835s ingested last 30 days | 15% | Closed-loop confidence |
| Reconciliation runs last 90 days | 10% | Multi-doc engagement |
| NPS / CSAT last quarter | 10% | Stated satisfaction |
| Open P1/P2 tickets older than SLA | -10% | Active pain |
| Denial-rate trend last 90 days | 15% | Outcomes — the value prop |

Scores 0–40 = at risk (CSM intervention this week). 41–70 = neutral (monthly check-in). 71–100 = healthy (quarterly business review + expansion conversation).

## QBR (Quarterly Business Review) — Org+

90-minute quarterly meeting per Enterprise customer (semi-annual for Org). Agenda:

1. **Outcomes**: denial-rate trend, top 5 CARC classes by $ impact, pre-flight catch rate.
2. **Adoption**: WAUs, lookup volume, reconciliation runs, alert engagement.
3. **Risks**: open tickets, recent incidents, upcoming payer changes affecting them.
4. **Roadmap preview**: 1–2 features in next 90 days that affect them.
5. **Expansion**: more seats, more states, additional specialty pack, white-label tier.

## Support escalation

```
L1 (CSM/Support Engineer) — answers from KB + product
   └─ resolution target: same business day
L2 (Senior Support Engineer) — replicates issues, files bugs
   └─ resolution target: 3 business days
L3 (Engineering on-call) — code-level debugging, hotfixes
   └─ engaged for SLA-breach risk or P0/P1 incidents
L4 (Engineering manager + Product) — design/architecture decisions
```

P0 (data breach, cross-tenant leak, lookup down for >15 min) skips L1 and goes straight to L3 + incident commander per `RUNBOOKS/incident-response.md`.

## Status page + comms

- `status.<domain>` (StatusPage.io). Components: Lookup, Synthesis, Webhooks, Reconciliation, Auth, 835 Ingestion.
- Customers subscribe per-component via email/SMS/Slack.
- Incident updates use **Investigating → Identified → Monitoring → Resolved** lifecycle from `on-call.md`.
- Post-mortem within 5 business days for any P0/P1; published on the status page (PHI redacted).

## Knowledge base

Required content at GA:

- **Getting started**: lookup, reconciliation, 835 upload.
- **Per CARC class**: what it means, how we detect it, what to do.
- **Per specialty pack**: palliative, behavioral health, oncology, DMEPOS, WC.
- **Per integration**: Availity, Change Healthcare, Waystar webhook setup; SCIM provisioning; SSO; Slack/Teams alerts.
- **Loom library**: 30+ short videos (≤3 min each), reviewed quarterly.

Self-serve deflection target: ≥40% of L1-eligible questions answered by KB without ticket.

## Renewal + expansion

- **Auto-renewal** at month 11 for annual contracts (60-day notice required to opt out per MSA template).
- **Renewal calls** scheduled by CSM at month 10 — open conversation about pricing changes, expansion, new specialties.
- **Expansion paths**:
  1. More seats (existing tier).
  2. Tier upgrade (Team → Org → Enterprise).
  3. Specialty pack add-on (oncology, DMEPOS, WC, IHS, ASC).
  4. White-label (Enterprise only).
  5. Risk-adjustment / HCC product (Phase 6+).
- **Net Revenue Retention target**: 120% by end of Year 2.

## Churn handling

When a customer signals intent to churn:

1. **Save call** within 48 hours — CSM + product owner.
2. Identify root cause from health signals: usage drop, unresolved tickets, missed onboarding milestones, payer-coverage gap.
3. Negotiate: pause (≤90 days), tier downgrade, scope reduction. Last resort: discount.
4. **Loss report** if churn proceeds — categorize reason (price / product gap / competitor / acquisition / out of business). Quarterly review of loss reports drives roadmap.

## Voice of customer

- **In-app NPS** quarterly, sampled (not all users every quarter).
- **CSAT** post-ticket (1-click 5-star).
- **Customer Advisory Board** (Year 2): 8–12 customers, quarterly meeting, early product preview, paid honorarium.
- **#feature-requests** Slack channel (Org+) feeds product backlog.

## Design partner program (first 5 customers)

- 50% Year-1 discount.
- Reference logo + case-study rights.
- Bi-weekly product feedback session.
- Direct line to CTO + product.
- Convert to standard pricing in Year 2 with locked-in 20% discount.

## Compliance touch-points the CSM must know

- BAA on file before any PHI-bearing 835 file flows.
- WMHMDA notice for Washington-resident users — surface in tenant settings.
- Colorado AI Act: customer-side notification of AI use (we provide template).
- AB 3030: customer using our content downstream in patient-facing comms must add disclaimer (we provide guidance doc).
- 42 CFR Part 2 SUD claims require active TPO consent — surface refusal UX clearly so customer doesn't think it's a bug.
- AMA CPT licensing: customer must accept AMA EULA before first CPT-descriptor display.
