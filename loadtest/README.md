# Load tests (k6)

Tests we run before promoting a release. The lookup endpoint is the
most-traffic-sensitive surface; its SLO is **p95 < 2s** and **error rate
< 0.1%**, enforced by the k6 thresholds in `lookup.k6.js`.

## Prereqs

- A running backend with seeded data (all migrations applied).
- An `org` row + at least one `payer` (the platform's seeds satisfy this).
- k6 ≥ 0.50 (https://k6.io).

## Scripts

| Script | What it covers | SLO it enforces |
|---|---|---|
| `smoke.k6.js` | quick 60s sanity across `/healthz`, `/readyz`, `/v1/lookup`, `/v1/billing/entitlement` | per-endpoint p95/p99 + 0% failure |
| `lookup.k6.js` | sustained `/v1/lookup` traffic at configurable RPS | p95 < 2s, errors < 0.1% |
| `synthesis.k6.js` | three-stage cold/warm/mixed `/v1/synthesis` ramp; cache hit rate observable | p95 < 8s, p99 < 15s, errors < 0.5% |

## Run

```powershell
# Smoke (60s)
k6 run loadtest/smoke.k6.js `
  -e BASE_URL=http://localhost:3000 `
  -e ORG_ID=11111111-1111-4111-8111-111111111111

# Lookup steady-state (default: 25 RPS for 5 minutes)
k6 run loadtest/lookup.k6.js `
  -e BASE_URL=http://localhost:3000 `
  -e ORG_ID=11111111-1111-4111-8111-111111111111

# Lookup ceiling: 100 RPS for 10 min
k6 run --vus 200 -e RPS=100 -e DURATION=10m loadtest/lookup.k6.js

# Synthesis with cache effects
k6 run loadtest/synthesis.k6.js `
  -e BASE_URL=http://localhost:3000 `
  -e ORG_ID=11111111-1111-4111-8111-111111111111
```

A non-zero exit code means a threshold was violated — wire the same
script into the production deploy gate.

## CI integration

`smoke.k6.js` runs on every staging deploy via the `loadtest-smoke`
GitHub Actions job. `lookup.k6.js` + `synthesis.k6.js` run nightly
against staging via a separate scheduled workflow that posts results
to Datadog as custom metrics:

```
billing_rules.k6.lookup.p95_ms
billing_rules.k6.synthesis.p95_ms
billing_rules.k6.synthesis.cache_hit_rate
```

Datadog dashboard `Billing Rules — API Health` watches these for
regression.

## What's deliberately NOT covered yet

- `POST /v1/era835/upload` — high-volume bulk uploads. Add when a real
  customer traffic pattern emerges and we have a representative file
  corpus.
- Reconciliation endpoints — analyst-driven, not request-rate-bound.
- Browser extension API — exercised by frontend Playwright suite, not k6.
