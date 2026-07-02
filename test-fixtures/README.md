# Medicare extraction + comparison test fixture

A synthetic Medicare "final rule" PDF with **12 deliberately-varied billing
scenarios**, plus a companion org rulebook CSV, to verify the platform
**extracts** rules from a policy PDF and **compares** them against an org's
rulebook — end to end, live.

## What's here

| File | Purpose |
|------|---------|
| `../scripts/gen-medicare-test-pdf.mjs` | Renders the PDF → `public/test-fixtures/medicare-final-rule-2026.pdf` (puppeteer) |
| `../db/seed/ingestion-source-medicare-pdf.sql` | Registers that PDF URL as an ingestion source bound to **Medicare / OH** so extracted rules persist |
| `medicare-org-rulebook.csv` | An org rulebook to upload (Path B) — planted conflicts + an unverifiable code |
| `../scripts/verify-medicare-extraction.mjs` | Automated front-to-back proof (extraction + all comparison outcomes) |

## The 12 scenarios (what extraction should pull)

| Code | Scenario | Determination |
|------|----------|---------------|
| 99347–99350 | Home visits 15/25/40/60 min | **covered** |
| 99497 | Advance care planning, first 30 min | covered (documentation required) |
| 99498 | ACP, each additional 30 min | covered (add-on with 99497) |
| 99453 | RPM set-up | **not_covered** |
| 99454 | RPM device, 30 days | covered (frequency limit) |
| 99457 | RPM management, first 20 min | covered (**prior auth**) |
| 98016 | Virtual check-in | covered (**telehealth**, modifier 95) |
| 99251 | Inpatient consult | **not_covered** (Medicare denies consults) |
| G0179 | Home-health recert | covered (1 per 60-day episode) |

## Run it

```bash
# 1. Generate + serve the PDF (on the VPS)
node scripts/gen-medicare-test-pdf.mjs
# rebuild/restart so Next serves public/; confirm it 200s:
#   https://app.pallio.io/test-fixtures/medicare-final-rule-2026.pdf

# 2. Register the source (binds Medicare + OH → rules persist)
sudo -u postgres psql pallio -f db/seed/ingestion-source-medicare-pdf.sql

# 3. Extract + verify (triggers the cron itself when CRON_SECRET is set)
BASE_URL=https://app.pallio.io CRON_SECRET=… \
  node scripts/verify-medicare-extraction.mjs
```

Or drive it by hand: fire `POST /api/cron/ingest-documents`
(`x-cron-secret` header), then in the app upload `medicare-org-rulebook.csv`
under **Knowledge → upload rulebook** and open the comparison.

## Expected comparison outcomes (medicare-org-rulebook.csv)

The comparison keys on `(payer, state, cpt, attribute)`; a green **match**
needs *identical* coverage **and** value, so the CSV is built to show the
differences that matter:

- **diff** — `99350` (org *not_covered* vs Pallio *covered*), `99453` (org
  *covered* vs Pallio *not_covered*), `99251` (org *covered* vs Pallio
  *not_covered*). These are the "you were billing/denying this wrong" catches.
- **unverified** — `99406` (org has it; it isn't in the CMS rule).
- **new_from_pallio** — every covered code the org omitted (`99347–99349`,
  `G0179`, …) plus the specialty attributes Pallio extracted (prior-auth,
  telehealth, frequency limit, add-on). "Rules you're missing."
- **match** — demonstrated by the verifier (step D): it echoes a real
  extracted value straight back and the row comes back green.

> Synthetic fixture — **not** an official CMS publication. Safe to leave in the
> repo; the ingestion source is clearly labelled `TEST — …`.
