# GA Launch Retrospective Template

Filled in at T+14 days post-cutover. Owner: CTO. Reviewers: full team +
design-partner customers (CSAT section anonymized in shared version).

## 1. Headline

One sentence on the launch outcome. Example: "First 5 design partners
onboarded; lookup p95 stayed under 1.4s; one P2 (synthesis flag)
mistakenly enabled global, rolled back in 18 minutes."

## 2. Numbers

| Metric | Target | Actual | Source |
|---|---|---|---|
| Lookup p95 | < 2s | _____ | Datadog APM |
| Lookup error rate | < 0.1% | _____ | ALB 5xx |
| Synthesis refusal rate | < 5% (when enabled) | _____ | App metric |
| Hallucination eval pass rate | ≥ 95% | _____ | Eval suite |
| 835s ingested | first DP feed live within 7d | _____ | Pipeline |
| Onboarding completion time | < 60 min Org tier | _____ | CSM log |
| WAU / seats first 14 days | > 70% | _____ | Telemetry |
| P0 incidents | 0 | _____ | Status page |
| P1 incidents | ≤ 1 | _____ | Status page |
| Mean ack-to-resolution P1 | < 60 min | _____ | PagerDuty |

## 3. What we did well

(Bulleted; concrete; cite logs/dashboards/PRs by ID. Not "communication
was great" — "the cutover Slack channel hit ack-to-update <5 min for all
12 status posts, attached.")

## 4. What we'd change

Same rules as section 3. Each item gets:
- Concrete observation (not vibe).
- Root cause (5 whys, one paragraph).
- Action item with owner + due date.

## 5. Action items

| # | Owner | ETA | Tracking ticket | Status |
|---|---|---|---|---|
| 1 |  |  |  | open |
| 2 |  |  |  | open |

No action item closed without verification — re-run the failure scenario
or attach test evidence.

## 6. Customer impact + comms quality

- Status-page incidents posted: count + severity + median time to first
  update + median time to resolve.
- Customer-perceived issues: tickets opened first 14d (count + median TTR).
- Design-partner CSAT: survey at T+14, target NPS ≥ 50.
- Any customer who churned or paused in the window: full root cause.

## 7. Compliance + audit posture

- BAA + sub-processor BAAs verified post-cutover (re-confirmed dates).
- SOC 2 Type 2 evidence collection running (control sample requested
  from each domain).
- HIPAA breach analysis: any incident considered for OCR notification?
  Decision + reasoning attached.
- AMA license usage volume vs license tier — exceeded? warning?

## 8. Cost vs forecast (first 14 days)

| Line item | Forecast | Actual | Variance |
|---|---|---|---|
| AWS compute (ECS + RDS) | _____ | _____ | _____ |
| AWS storage + bandwidth | _____ | _____ | _____ |
| Bedrock inference | _____ | _____ | _____ |
| Datadog | _____ | _____ | _____ |
| Stripe processing | _____ | _____ | _____ |
| Sub-processors (Comprehend, Vanta) | _____ | _____ | _____ |

If any line is >25% over forecast, root-cause + cost-optimization
ticket filed.

## 9. Roadmap impact

What did launch teach us that changes the next 60 days?
- Features promoted (if customers asked for them in week 1):
- Features deprioritized:
- Tech debt items surfaced by real load:

## 10. Sign-offs

- CTO:
- CEO:
- Compliance lead:
- Design-partner-1 contact (optional, after sanitization):

Post-mortem published to `docs/POST-MORTEMS/ga-launch-YYYY-MM-DD.md` and
linked from the on-call channel within 5 business days of T+14.
