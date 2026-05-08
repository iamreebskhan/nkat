# Post-Launch Playbook (T+0 → T+30)

The day-by-day cadence after the first prod cutover. The goal: catch
problems early, document outcomes, and convert the first paying tenant
into a reference customer.

---

## T+0 — cutover day

| Hour | Owner | Action |
|---|---|---|
| 0:00 | CTO | Status-page "Service launched" informational post |
| 0:00 → 2:00 | On-call P+S | Watch Datadog + status page; any anomaly → rollback per `production-cutover.md` |
| 0:00 → 2:00 | CSM | Customer-facing line open in `#dp-<customer>` Slack |
| 2:00 | CTO | If clean, mark cutover "Resolved" on status page |
| 2:00 | All | `#release-launch` retro — what surprised us in 2h |

Post-mortem if any P0/P1 fired during the window: 5-business-day deadline per `on-call.md`.

---

## T+1

- [ ] **Eng on-call**: 24h dashboard sweep. Confirm no spurious 5xx, p95 stable, no Datadog forwarder backpressure.
- [ ] **CSM**: tenant admin onboarding call (60 min) — first lookup + first reconciliation + 835 ingestion config.
- [ ] **Eng**: confirm welcome email arrived, footer renders, List-Unsubscribe button visible in Gmail.
- [ ] **Compliance**: AWS CloudTrail + RDS audit logs flowing to S3.

## T+2

- [ ] **Eng**: first nightly `pg_dump` succeeded; restore-to-staging smoke runs the schema-shape suite.
- [ ] **CSM**: tenant has at least 5 lookups + 1 saved rulebook draft.

## T+3

- [ ] **CSM**: first synthetic 835 file ingested with the tenant; denial dashboard reviewed together.
- [ ] **Eng**: review `email_send` for any `failed` rows. Investigate any classes outside the known `isRetryable` list.

## T+5

- [ ] **Eng**: first weekly digest email rendering verified end-to-end (View source, inspect headers, click unsubscribe to confirm round-trip — then DELETE the suppression row via admin to undo the test).
- [ ] **CSM**: tenant CSAT pulse — 1-question NPS.

## T+7

- [ ] **All**: cutover retrospective (mandatory, even if clean). Action items filed.
- [ ] **Eng**: review Stripe `billing_event` for any unhandled event types in the prod feed.
- [ ] **Compliance**: SOC 2 Type 2 evidence sample collected from the first week.

## T+14

- [ ] **All**: GA-launch retro template (`GA-LAUNCH-RETRO.md`) filled in. Posted to `docs/POST-MORTEMS/ga-launch-YYYY-MM-DD.md`.
- [ ] **CTO/CEO/Compliance**: sign-offs captured.
- [ ] **CSM**: tenant T+14 NPS — target ≥ 50.
- [ ] **GTM**: first case study draft.

## T+30

- [ ] **CSM**: tenant 90-day review prep + agenda set.
- [ ] **Eng**: first month cost-vs-forecast review (compute, RDS, SES, Bedrock, Datadog).
- [ ] **Compliance**: external pen-test re-engagement scheduled (annual cadence).
- [ ] **GTM**: design-partner #2 outreach starts.

---

## What we measure during the window

Daily snapshot to `#release-launch`:

| Metric | Target | Source |
|---|---|---|
| Lookup p95 | < 2s | Datadog APM |
| Lookup error rate | < 0.1% | ALB 5xx |
| `email_send` success rate | > 95% | DB query |
| Welcome / trial-ending / dunning sends | as expected | DB query, cross-ref `subscription.status` |
| Webhook delivery dead-letter count | 0 | DB query |
| Hallucination eval pass rate | ≥ 95% | Eval suite (weekly) |
| Tenant NPS / CSAT | ≥ 50 | In-app survey |
| Open P0/P1 incidents | 0 | PagerDuty + status page |

A red row triggers an investigation thread in `#release-launch` the same day.

---

## Roll-forward criteria for design-partner #2

We don't onboard a second customer until:

1. T+14 retro is signed off.
2. No P0 incidents in the first 14 days.
3. Tenant #1 NPS ≥ 50 OR tenant has a written agreement to sponsor a fix-list.
4. SOC 2 Type 2 evidence collection has at least one full week of clean control samples.
5. Cost-per-tenant is within 50% of the forecast (gives us margin headroom to add the next).

If any of these is red, design-partner #2 onboarding pauses while we resolve. We don't compound risk by stacking customers on a wobbly base.

---

## What we DON'T do in the first 30 days

- Refactor production code paths exercised by the live tenant (forced by P0 only).
- Add new specialty packs that aren't in the design partner's order form.
- Change pricing on the design-partner contract (fixed per Order Form).
- Schedule new infra rollouts (Terraform changes are diffed but applied only for hotfixes).
- Onboard a second tenant (see roll-forward criteria above).

The first 30 days are about **proving the rails are stable**, not about velocity.
