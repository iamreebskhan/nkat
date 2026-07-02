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

---

# Real CMS ruling documents (extraction + comparison)

Same flow as above, but against **genuine, current CMS documents** instead of
the synthetic PDF — for testing extraction on Hamda's operator account.

## Why self-hosted (not a direct cms.gov URL)

CMS's bot manager **403s server-side fetchers** — the ingest cron sends
`User-Agent: Pallio-ingest/1.0`, which CMS blocks (a browser UA is served
fine). So we download the PDFs with a browser UA and serve them from the app
itself; the cron then fetches from `app.pallio.io`, never from CMS.

The **full** Federal Register final rule (~1,000+ pages, > 32 MB) is
deliberately **not** used — it exceeds Claude's native-PDF ceiling
(600 pages / 32 MB on a 1M-context model) and would extract **zero** rules.
Instead we use CMS's own short, rule-dense documents:

| File (self-hosted) | Real CMS doc | Pages | Codes it covers |
|---|---|---|---|
| `cms/mm14315-pfs-final-rule-summary-cy2026.pdf` | CY2026 PFS **Final Rule Summary** (CMS-1832-F, MM14315) | 6 | new G0552–G0554, G2211, home visits 99347–99350 |
| `cms/mln901705-telehealth-rpm.pdf` | Telehealth & RPM (MLN901705) | 14 | telehealth G0320–G0322, RPM 99457/99458, RTM 98980/98981 |
| `cms/mln006764-evaluation-management.pdf` | E/M Services (MLN006764) | 29 | home-visit E/M 99341–99350, nursing-facility E/M |
| `cms/mln909289-advance-care-planning.pdf` | Advance Care Planning (MLN909289) | 5 | ACP 99497/99498 |

These are U.S. Government works. The binaries are **git-ignored**
(`public/test-fixtures/cms/`) — they embed AMA CPT descriptors, so they're
fetched fresh on the VPS rather than committed.

## Run it

```bash
# 1. Download + self-host the real CMS PDFs (browser UA → works around bot-block)
node scripts/fetch-cms-real-pdfs.mjs
#    → public/test-fixtures/cms/*.pdf, served at /test-fixtures/cms/<file>.pdf
#    rebuild/restart if your Next build doesn't serve public/ live

# 2. Register them as ingestion sources (Medicare + OH)
sudo -u postgres psql pallio -f db/seed/ingestion-source-cms-real.sql

# 3. Extract + verify (triggers the cron itself when CRON_SECRET is set)
BASE_URL=https://app.pallio.io CRON_SECRET=… \
  node scripts/verify-cms-real-extraction.mjs
```

Or by hand: fire `POST /api/cron/ingest-documents`, then upload
`cms-org-rulebook.csv` under **Knowledge → upload rulebook** and open the
comparison.

## Expected outcomes (`cms-org-rulebook.csv`)

- **diff** — `99349`, `99350`, `99497` (org marked them *not_covered*; CMS
  pays them) — the "you were denying payable services" catches.
- **unverified** — `99406` (org-only; not in these CMS docs).
- **new_from_pallio** — every real CMS code the org omitted (telehealth,
  RPM, ACP add-on, the new CY2026 G-codes…).
- **match** — the verifier echoes a real extracted value back for a green row.

Real CMS text is less deterministic than the synthetic fixture, so the
verifier checks a **threshold** (≥ 3 codes extracted), not exact per-code
coverage.
