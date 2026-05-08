# Phase 37 — Datadog Dashboards as Terraform + k6 Coverage Expansion

## Why this phase

Two operational gaps:

1. **Dashboards drift.** Hand-clicked Datadog dashboards have no PR
   review, no rollback, no environment parity. We've been operating
   that way to date; this phase pulls them into Terraform so a
   widget change is a code review, and `staging` + `prod` always
   render the same shape.

2. **Load-test coverage is single-endpoint.** `lookup.k6.js` is great
   for the lookup SLO but doesn't exercise synthesis (cache-sensitive,
   different latency envelope) or the readiness/health endpoints
   (which a deploy gate should smoke before promotion).

## What landed

### Terraform — Datadog provider + dashboards

- `infra/terraform/versions.tf` — added the `DataDog/datadog` provider
  pinned to `~> 3.50`. Credentials come from env (`DD_API_KEY`,
  `DD_APP_KEY`) at the runner; nothing committed.

- `infra/terraform/datadog-dashboards.tf` — two dashboards + four
  monitors (alerts):

  Dashboards:
  - **API Health (env)** — RPS by endpoint, latency p50/p95/p99,
    5xx rate query-value with red/yellow/green thresholds,
    rate-limit 429s by scope, JWKS fetch p95, Postgres pool
    in-use vs idle, slowest queries by signature.
  - **Domain Signals (env)** — synthesis cache hit rate, synthesis
    cost USD/hour, hallucination eval pass rate (24h),
    `era_835` ingestion lag, Stripe rotation-secret hits by index,
    top denial classes by $ impact.

  Monitors:
  - 5xx rate > 1% (warning 0.5%, critical 1%).
  - p95 latency > 2s (warning 1.5s, critical 2s).
  - hallucination pass rate < 95% over 24h.
  - Stripe rotation overrun — alerts when `secret_index:1` (the
    PREVIOUS rotation secret) is still authenticating any traffic
    > 24h after deploy.

  Tagged `service:billing-rules-api`, `env:<env>`, parameterized
  via dashboard `$env` template variable.

### k6 expansion (`loadtest/`)

- `smoke.k6.js` (new) — 60-second multi-endpoint sanity check;
  per-endpoint thresholds (`/healthz` p99 < 500ms, `/readyz` p99
  < 1s, `/v1/lookup` p95 < 2s, `/v1/billing/entitlement` p95
  < 500ms). Bearer auth optional. Wired for the staging deploy gate.
- `synthesis.k6.js` (new) — three-stage scenario:
  - cold (1m @ 2 RPS) — seeds the cache.
  - warm (3m @ 10 RPS) — exercises cache hits; thresholds enforced
    only on this stage (`p95 < 8s`, `p99 < 15s`, errors < 0.5%).
  - mixed (1m @ 5 RPS) — 50% nonces force cache misses; observes
    behavior at lower hit rate.
  - Reads the `x-synthesis-cache: hit|miss` response header into
    custom k6 counters so the cache hit rate is a graphable metric.
- `lookup.k6.js` unchanged — already strong.
- `loadtest/README.md` — rewritten with all three scripts + the CI
  wiring narrative (smoke runs every staging deploy; lookup +
  synthesis run nightly; results posted to Datadog as
  `billing_rules.k6.*` metrics).

## Trade-offs noted in the dashboard

- Metric names like `billing_rules.synthesis.cache_hit{...}` and
  `billing_rules.stripe.webhook_secret_index{secret_index:N,...}`
  must be emitted by the application — they are referenced by both
  the dashboards and the monitors. Phase 38 verification confirms
  the application code emits matching metric names.
- The `evaluation_delay = 60` on the 5xx monitor avoids alert flap
  on freshly-deployed canaries that haven't received traffic yet.
- All monitors `notify_no_data = false` because zero traffic for
  staging environments is a normal state, not an alert condition.

## Next phase

Phase 38 — final verification. Run integration suite, full unit
suite, OpenAPI export, smoke against the dev compose, document
overall numbers.
