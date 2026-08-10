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
| `extract:fee-schedules-full-2026-08` | 2,745 | 10 | 427 | 1 | coverage + rates, OH/NC Medicaid + CMS RVU |
| `crawler:cms_pfs` | 1,689 | 1 | 447 | 8 | CY2026 Medicare PFS Final Rule — multi-attribute |
| `extract:denial-rules-2026-08` | 924 | 10 | 37 | 9 | the denial-driving attributes, from payer manuals |
| `extract:payer-docs-2026-08` | 169 | 9 | 11 | 7 | telehealth/POS/modifier, from policy documents |
| `extract:denial-rules-round2-2026-08` | 114 | 2 | 25 | 4 | UHC Ohio + Anthem Ohio prior auth, provider type, documentation, frequency |
| `extract:state-fee-schedule-2026-08` | 12 | 4 | 3 | 1 | state schedule remnants |
| `extract:humana-sc-editing-2026-08` | 8 | 1 | 8 | 1 | Humana SC place-of-service rule SC157 |

Roughly 5,660 live rules. Round 2 shows a smaller number than the facts it
carries because it consolidates — see the invariant below.

## The one-live-row invariant — read this before writing any seed

`fetchPayerRule` ends in:

```sql
ORDER BY (pr.payer_id IS NOT NULL) DESC,
         (pr.product_line = $1) DESC,
         pr.effective_date DESC
LIMIT 1
```

There is **no confidence tiebreak**. Two live rows on the same
`(payer, state, code, attribute)` with the same effective date means the
answer a nurse practitioner sees is whichever row the planner returns
first. That is not an answer.

So: **at most one live rule per key.** Every seed must expire what it
replaces, in the same transaction, before it inserts.

Expire at `GREATEST(victim.effective_date, successor.effective_date)`, not
at a fixed sentinel date. The table enforces
`expiration_date >= effective_date`, so an earlier date is rejected
outright; and because the lookup keeps a row while
`expiration_date > dos`, expiring at the successor's start leaves no date
on which the code has no rule. Where the two share a date the window
collapses to zero, which is legal and reads correctly — replaced, not
gapped.

When the row you are replacing holds a **different fact** rather than a
worse version of yours, merge it instead of dropping it: put your headline
fact in `source_quote` and carry the rest in
`value->'supportingQuotes'`, each with its own verbatim sentence. Round 2
did this with round 1's UnitedHealthcare telehealth rules.

Verify after every seed:

```sql
SELECT count(*) FROM (
  SELECT payer_id, state, code, attribute FROM payer_rule
   WHERE expiration_date IS NULL
   GROUP BY 1,2,3,4 HAVING count(*) > 1) d;   -- must be 0
```

## Verified in production, 2026-08-10

`scripts/verify-production.sh` — 21 checks, 0 failures, against the live
database rather than a development copy:

- migrations 0066–0068 applied; 26 seeds in the `seed_application` ledger
- 5,680 live rules; **0** duplicate keys, **0** citing a missing document,
  **0** without a verbatim quote (extracted, crawled and legacy alike)
- UnitedHealthcare Ohio 25/25/25/14 and Anthem Ohio 25 — both payers held
  no prior-auth rule at all before this
- 12 duplicate documents merged by 0068; every multi-payer document intact

Two facts worth keeping. The health check had been asserting port 3000
while the app serves **3020**, so it reported a wholly successful deploy
as a failure; it now resolves the port from the running process. And
`tsx` is not a dependency of this project, so anything invoking
`npx tsx` on the VPS blocks trying to download it — the service-level
check skips rather than hangs.

**Known version churn.** `source_document` holds a row per
(url, payer_id, content_hash), which is how a changed document is
recorded. Two sources mint versions faster than they change:

| document | versions | window |
|---|---|---|
| Federal Register CY2026 | 35 | 2026-07-02 → 07-03 (one-day burst, dormant) |
| Aetna policy page (HTML) | 13 | 2026-05-17 → 08-06 (~1 per 6 days, ongoing) |

Only the Aetna page is still accumulating. HTML whose bytes differ per
fetch — timestamps, ad slots, session ids — looks like a new version to a
byte hash, and each one can trigger a fresh extraction. The fix, when it
is worth doing, is to hash the EXTRACTED TEXT rather than the raw
response, so cosmetic changes stop counting.

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

**Does UnitedHealthcare Community Plan Ohio require prior auth for home
visits?** Only when the provider is out of network. The 11/1/2025 prior
authorization requirements document requires out-of-network physicians,
facilities and other health care professionals to obtain authorization for
all procedures and services, with emergency and urgent care the only
carve-out. For an in-network provider none of the palliative codes appear
on any prior-authorization list in that document. Its "Home health care"
row (G0151, G0152, G0153, G0156, G0299, G0300) is a home health **agency**
benefit and does not govern physician home-visit E/M.

**Who may bill a home visit under UnitedHealthcare Community Plan Ohio?**
Only MD, DO, NP, CNS, CNM or PA. Policy 2026R0112D defines E/M as CPT
98000-98016, 99091 and 99202-99499 — which contains every palliative E/M
code — and refuses reimbursement when the billing party is a nonphysician
health care professional under its own individual or group TIN. The barred
list includes RNs, LPNs, MSWs, LCSWs, home health agencies, home health
aides and visiting nurses. The payer's own FAQ answers the exact case:
99348 may not be reported by a home health specialty even though the
service happens in the residence.

**The trap in that policy: two different practitioner lists.** The
Telehealth/Virtual Health Policy lists CMS-designated practitioners
eligible to be reimbursed for telehealth — and that list *does* include
clinical social workers, dietitians and clinical psychologists. It is a
list of who may deliver a telehealth service, **not** of who may report an
E/M code. Reading it as E/M eligibility puts an LCSW on a telehealth home
visit and denies the claim. Both facts now live on one rule, and the
answer says so explicitly.

**Ohio's pharmacist exception does not reach palliative codes.** It is a
closed list: 99202, 99203, 99211-99215, plus 90460, 90471-90474 and 96372.
Washington's exception *does* list 99347-99350 and 99417 for pharmacists —
that is a different state and must not be imported into Ohio claims.

**Does Anthem BCBS Ohio require prior auth for home visits?** For
out-of-network services, yes — all of them except emergencies. For mental
health and substance use diagnoses, explicitly no, and the guide extends
that to home and prolonged visits. When Anthem is the secondary payer, no.
99499 does require it, as an unlisted/manually-priced code "ending in 99".
Nothing is asserted for an in-network physical-health visit: the guide is
a summary, so absence from its list is not clearance. One rule was
rejected in audit for making exactly that inference.

**Why do commercial payers have so few rules?**
They publish no publicly fetchable fee schedule. Coverage for them comes
from the benchmark fallback (see below) or from the practice's own
attestations. This is a property of the market, not a bug.

## Known blocks — environmental, not research failures

| what | status | how it closes |
|---|---|---|
| `scdhhs.gov` (SC Medicaid fee schedule) | **HTTP 403** to automated requests | fetch by hand, then rulebook CSV upload |
| `medmutual.com` (Medical Mutual of Ohio) | **connection refused** from this network | analyst attestation, or manual upload |
| `molinahealthcare.com` (Molina OH **and** SC) | **HTTP 403, `Server: AkamaiGHost`** | fetch by hand, then rulebook CSV upload |
| `providernews.anthem.com` | reachable, but **JavaScript-rendered** — a plain fetch returns 13 characters of shell HTML | captured with a browser; its ingestion source has `auto_extract = FALSE` so a crawl never reads the empty shell as "the rules vanished" |

All verified directly, not merely reported by an agent. Five SC plans
would gain coverage from the SC schedule.

Still without any monitored source: CareSource Ohio, First Choice SC,
Aetna. Not blocked — just not yet found.

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

Round 2 produced the counter-example that proves the point twice over.
Anthem Ohio requires prior authorization for "Home healthcare (physical,
occupational, and speech therapy) and skilled nursing (after 18 combined
visits)". That is a home health **agency** benefit. Mapping it onto
99341-99350 would have put a confident, wrong prior-auth flag on every
physician home visit in the state. It is recorded as an explicit scope
exclusion instead — the rule says out loud that it does not govern
physician home-visit E/M, so nobody re-derives it later and gets it wrong.

The auditor also rejected an SBIRT bundling rule whose direction was
inverted: the screening bundles into the E/M, not the reverse. A bundling
rule pointing the wrong way tells a practice to stop billing its own
visits.

Service-level rules are mapped to codes at extraction time, and the
mapping is recorded in `value->>'appliesToService'` so a human can audit
why a rule was attached to a code. The commonest extraction error is a
wrong mapping — home health *aide* services or hospice rules attached to
physician home visits — so every extraction runs an independent auditor
tasked specifically with catching it.

## One row per document VERSION per payer

`source_document` is unique on `(url, payer_id, content_hash)`, and each
part of that key is load-bearing.

**Not `(url)`.** One state Medicaid clinical policy governs every MCO in
the state — a single North Carolina policy is cited by UnitedHealthcare
NC, Carolina Complete, Healthy Blue, AmeriHealth Caritas and EBCI. Each
payer gets its own row so each payer's rules cite their own payer's
document. 18 rows exist only for that reason. Collapsing them would
destroy per-payer citation, not repair it.

**Not `(url, payer_id)` either.** A second row at the same URL is how the
crawler records that a watched document *changed*.
`ingestDocumentFromUrl` checks idempotency on `(content_hash, payer_id)`
then inserts with no `ON CONFLICT`: new bytes → new hash → the check
misses → a fresh row with its own `retrieved_at`. Rules keep citing the
version they were extracted from. Forbidding that would make the insert
raise 23505 forever, and because the ingest cron records the error on the
source row and moves on, the document would just **stop being
re-ingested, silently** — the only symptom a rising
`consecutive_failures`. 18 of 25 registered sources point at a URL that
already has a row for that payer, so that is the steady state.

The triple key says the true thing: new version, new row; same version
twice, rejected.

**What it does not catch, and what does.** Migration 0068 merged 10
duplicated documents created by two seed files that each registered the
same fee schedule under the same payer with different invented hashes —
which the triple key would not have blocked. That class of bug is a
property of the *files*, so it is caught in the files:
`scripts/check-seed-documents.mjs` fails the deploy when two manifest
seeds claim one `(url, payer_id)` under different ids. `deploy.sh` runs it
before applying any seed.

## Grounding

No rule reaches the library on an unverified quote. Every extraction runs
a programmatic check that `source_quote` appears **verbatim** in the
source document; anything that fails is dropped, not downgraded.

The normaliser that check uses forgives whitespace, unicode punctuation,
and **list-marker glyphs standing alone between spaces** — the same bullet
arrives as `•` from one PDF extractor, as `�` from another when the
font encoding is unmapped, and gets transcribed as an en-dash by a reader
looking at the rendered page. A dash *inside* a token is left alone,
because there it carries meaning: `99202-99499` must not quietly match
`99202 99499`. Confirm any change to it against these three cases, which
must still fail: a flipped negation ("will reimburse" vs "will not
reimburse"), an altered code range, and a stripped range dash.

Prove the quote is contiguous in the source, not stitched together across
bullet lines. Two round-2 rules were caught doing exactly that; one was
re-grounded from the raw extraction and kept, the other dropped. Seeds
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
- `npx tsx scripts/verify-denial-rules-round2.ts` — drives `lookupRule()`
  for the round-2 payers and asserts on what a biller would actually see,
  including that every answer carries a verbatim citation and a document
  URL. Re-run it after touching the lookup or these seeds.

Snapshot the baseline **from production**, not a dev database: a local
copy missing a seed will record artificially low numbers and then pass
every future check. That happened once — `frequency_limit` and
`units_per_period_max` were reported as zero when production held 51 and
207 rules, because the Final Rule seed had never been applied locally.
