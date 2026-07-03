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

## How it fetches CMS (browser UA, direct)

CMS's bot manager **403s non-browser User-Agents** — the ingest engine used to
send `Pallio-ingest/1.0`, so it couldn't fetch cms.gov (Source 1) at all. The
engine now sends a standard browser UA (`fetchUrlBytes`), which CMS serves — so
the ingestion sources point **directly at cms.gov**. No self-hosting, no
`public/` serving, no rebuild.

The **full** Federal Register final rule (~1,000+ pages, > 32 MB) is
deliberately **not** used — it exceeds Claude's native-PDF ceiling
(600 pages / 32 MB on a 1M-context model) and would extract **zero** rules.
Instead we use CMS's own short, rule-dense documents:

| Real CMS doc | Pages | Codes it covers |
|---|---|---|
| CY2026 PFS **Final Rule Summary** (CMS-1832-F, MM14315) | 6 | new G0552–G0554, G2211, home visits 99347–99350 |
| Telehealth & RPM (MLN901705) | 14 | telehealth G0320–G0322, RPM 99457/99458, RTM 98980/98981 |
| E/M Services (MLN006764) | 29 | home-visit E/M 99341–99350, nursing-facility E/M |
| Advance Care Planning (MLN909289) | 5 | ACP 99497/99498 |

## Run it

```bash
# 1. Seed the Medicare payer (there's no Medicare row in the base seed — without
#    it, CMS sources bind to NULL and extract nothing)
sudo -u postgres psql pallio -f db/seed/payer-medicare.sql

# 2. Register the CMS ingestion sources (direct cms.gov URLs, Medicare + OH)
sudo -u postgres psql pallio -f db/seed/ingestion-source-cms-real.sql

# 3. Extract + verify (triggers the cron itself — use your REAL cron secret)
BASE_URL=https://app.pallio.io CRON_SECRET=your-secret \
  node scripts/verify-cms-real-extraction.mjs
```

Or by hand: fire `POST /api/cron/ingest-documents`, then upload
`cms-org-rulebook.csv` under **Knowledge → upload rulebook** and open the
comparison.

> **Optional offline fallback** — `scripts/fetch-cms-real-pdfs.mjs` downloads
> the PDFs into `public/test-fixtures/cms/` (git-ignored — they embed AMA CPT
> descriptors) if you ever need to self-host instead of fetching cms.gov live.
> Only useful if your deploy serves `public/` at runtime.

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

---

# Full final rule — chunked ingestion (going global)

The **entire** CY2026 PFS final rule (Federal Register 2025-19787) is **1,216
pages / 211 MB** — 2× the 600-page limit and 6.6× the 32 MB size limit, and
~3–4M tokens (several times the 1M context window). **No model can ingest it
whole** — the limit is identical for Sonnet 4.6, Sonnet 5, and Opus 4.8 (all
1M-context). So we **chunk** it: split into ≤40-page pieces and extract each.

Extraction now runs on **Opus 4.8** (`lib/ai/document-rule-extractor.ts`) for
best quality on dense regulatory prose.

## How it works

```
full rule PDF (211MB/1216pp)
  → qpdf --split-pages=40 → ~31 chunks (≤40pp, ≤~9MB each)
    → POST each chunk to /api/cron/extract-pdf (x-cron-secret)
      → ingestDocumentFromUrl({inlinePdfBase64}) → Opus 4.8 → payer_rule
```

Rules from every chunk merge into the global corpus and go live for all org
users. `/api/cron/extract-pdf` is secret-gated (same trust boundary as the
ingest cron); the chunk POSTs go to `localhost:3020` to bypass the gateway
timeout (Opus extraction on a dense chunk is slow).

## Run it (VPS)

```bash
# one-time: tools + Medicare payer + a rebuilt app (extract-pdf route + Opus 4.8)
sudo apt-get install -y qpdf curl
sudo -u postgres psql pallio -f db/seed/payer-medicare.sql
# git pull && npm run build && pm2 restart pallio   (server code changed)

CRON_SECRET=your-secret node scripts/ingest-full-rule-chunked.mjs
```

Tunables (env): `RULE_URL`, `CHUNK_PAGES` (default 40), `STATE` (default OH),
`DOCTYPE` (default cms_pfs), `CRON_URL` (default `http://localhost:3020`),
`PAYER_ID` (skip the demo-login payer resolve).

Verify what landed:

```bash
sudo -u postgres psql pallio -c \
 "SELECT count(*) FROM payer_rule WHERE created_by='crawler:cms_pfs' AND expiration_date IS NULL;"
```

## Cost / notes

- ~31 chunks × one Opus 4.8 call each per full ingest. Much of the rule is
  comment/preamble, so per-page rule yield is lower than the curated MLN docs —
  budget accordingly.
- Idempotent: each chunk dedupes on content hash, so re-running skips unchanged
  chunks. To force a clean re-extract, delete the rule's `source_document` rows
  first.
- Citations point at `RULE_URL` (the real Federal Register rule); the chunk
  page-range is recorded in the source-document title.

## Pre-extracted CY2026 full-rule seed (zero API cost)

**`db/seed/payer-rules-cy2026-full-rule.sql`** contains the complete CY2026
final rule already extracted — apply it with plain SQL, no Anthropic API calls:

```bash
sudo -u postgres psql pallio -f db/seed/payer-medicare.sql               # payer (if not already)
sudo -u postgres psql pallio -f db/seed/payer-rules-cy2026-full-rule.sql # the full rule
```

How it was produced: the full Federal Register text (90 FR 49266–50481, all
1,216 pages / 4.6 MB of text) was split into 44 overlapping slices and
extracted by 44 parallel Claude agents using the **same contract** as
`lib/ai/document-rule-extractor.ts` (attribute enum, coverage enum, code
regex, verbatim quotes). Every one of the 649 raw extractions passed
programmatic grounding (its quote appears verbatim in the source text — zero
hallucinations dropped); deduped to **563 unique (code × attribute) rules**,
seeded for OH/NC/SC (1,689 rows) at confidence 0.95, cited to the Federal
Register document.

Attribute spread: 356 covered · 69 units_per_period_max · 48 bundled_with ·
29 telehealth_allowed · 21 documentation_required · 17 frequency_limit ·
17 provider_taxonomy_allowed · 6 modifier_required.

The seed supersedes older active rules for the same (code, attribute) keys
and is idempotent (re-running replaces its own rows). For CY2027+ rules, use
the API pipeline above.
