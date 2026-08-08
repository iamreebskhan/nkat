# The rule library — what feeds it, what it knows, what it doesn't

Written so the questions below are answered once rather than
re-investigated every time someone notices a gap.

## What the library is for

From the master plan (`plan-emr-pivot-2026-05-23.md`), in the client's
words:

> no EMR shows the nurse practitioner which CPT codes their patient's
> payer actually accepts at the point of billing, and none predicts
> denials before submission

The denial-risk scorer specified there runs on `coverage_status`,
`modifier_required`, `prior_auth_required` and `frequency_limit`. Those
four are the library's reason for existing. **Coverage alone is not the
product** — a claim is rarely denied because a code is absent from a fee
schedule; it is denied for missing prior auth, wrong place of service, an
absent modifier, or an exceeded frequency cap.

## Sources

| source (`created_by`) | rules | payers | codes | attributes | what it gives |
|---|---|---|---|---|---|
| `crawler:cms_pfs` | 1,689 | 1 | 447 | 8 | CY2026 Medicare PFS Final Rule — multi-attribute |
| `extract:fee-schedules-full-2026-08` | 2,745 | 10 | 427 | 1 | coverage + rates, OH/NC Medicaid + CMS RVU |
| `extract:denial-rules-2026-08` | 952 | 10 | 37 | 9 | the denial-driving attributes, from payer manuals |
| `extract:payer-docs-2026-08` | 169 | 9 | 11 | 7 | telehealth/POS/modifier, from policy documents |
| `extract:humana-sc-editing-2026-08` | 8 | 1 | 8 | 1 | Humana SC place-of-service rule SC157 |

Roughly 5,600 live rules.

## Questions already settled — do not re-investigate

**Is the CY2026 Medicare Final Rule extraction complete and honest?**
Audited 2026-08 against a freshly downloaded copy of the 1,216-page rule
(Federal Register 2025-19787, 4.56 MB).
- **Correctness: 562/562.** Every stored `source_quote` appears verbatim
  in the source. Zero fabricated citations.
- **Completeness: 241 of 545 substantively-discussed codes (44.2%).** The
  304 skipped are thoracic surgery, urology, ophthalmology and similar —
  **zero of them fall in the palliative E/M or G-code range**. The
  extraction was correctly scoped, not truncated.
- Re-run the audit with `scratchpad/audit-medicare.mjs` if the seed changes.

**Does Medicare require prior authorisation for home-visit E/M?**
No. The CY2026 Final Rule contains 10 occurrences of "prior authoriz*"
and **none** links prior authorisation to E/M or home visits; the only PA
discussion is the WISeR model, which the rule states is voluntary. So
Traditional Medicare having zero `prior_auth_required` rules is correct,
not a gap. No "PA not required" rule is written — asserting a negative
from one document is not sound, and the denial scorer already behaves
correctly when a rule is absent.

**Why do commercial payers have so few rules?**
They publish no publicly fetchable fee schedule. Coverage for them comes
from the benchmark fallback (see below) or from the practice's own
attestations. This is a property of the market, not a bug.

## Known blocks — environmental, not research failures

| what | status | how it closes |
|---|---|---|
| `scdhhs.gov` (SC Medicaid fee schedule) | **HTTP 403** to automated requests | fetch by hand, then rulebook CSV upload |
| `medmutual.com` (Medical Mutual of Ohio) | **connection refused** from this network | analyst attestation, or manual upload |

Both verified directly, not merely reported by an agent. Five SC plans
would gain coverage from the SC schedule.

## The mistake that cost the most, so it isn't repeated

Ten payer manuals were once rejected for "naming no target CPT code", and
nothing was extracted from them. That filter is wrong: payers write

> home health visits require prior authorization after five visits

not `99349 requires prior authorization`. Filtering documents on the
presence of a CPT code discards nine of the ten attributes. Absolute
Total Care's manual alone carries 48 prior-authorisation statements;
Humana Ohio — which had zero rules — carries prior-auth and documentation
rules.

**Judge a source by whether it states rules about the SERVICES a
palliative practice delivers, never by whether it prints a code.**

Service-level rules are mapped to codes at extraction time, and the
mapping is recorded in `value->>'appliesToService'` so a human can audit
why a rule was attached to a code. The commonest extraction error is a
wrong mapping — home health *aide* services or hospice rules attached to
physician home visits — so every extraction runs an independent auditor
tasked specifically with catching it.

## Grounding

No rule reaches the library on an unverified quote. Every extraction runs
a programmatic check that `source_quote` appears **verbatim** in the
source document; anything that fails is dropped, not downgraded. Seeds
built from spreadsheets are read deterministically (SheetJS over cells),
so they carry no hallucination surface at all, and a self-consistency
gate aborts generation if an answer claims a status code, payment code or
dollar amount its own quote does not contain.

## The benchmark fallback

A payer with no published rule returns `status: unknown` — we do not know
that payer's rule — but carries what Medicare, or a Medicaid plan in the
same state, pays for the code, at `confidence: 0` and explicitly labelled
*"not this payer's rule"*. It is the sanity check a biller does by hand.
A real rule always outranks a benchmark.

## Health and coverage

- `GET /api/admin/library-health` — source health + per-payer coverage
- `npx tsx scripts/library-coverage-check.ts` — report
- `… --snapshot` writes the baseline; `… --check` fails on regression

Snapshot the baseline **from production**, not a dev database: a local
copy missing a seed will record artificially low numbers and then pass
every future check. That happened once — `frequency_limit` and
`units_per_period_max` were reported as zero when production held 51 and
207 rules, because the Final Rule seed had never been applied locally.
