#!/usr/bin/env bash
# verify-production.sh — prove the production database is actually right.
#
# Run on the VPS, AFTER scripts/deploy.sh:
#   sudo bash /opt/pallio/app/scripts/verify-production.sh
#
# Everything a developer checks locally is a claim about a laptop. This
# checks the database the client's practices actually bill against, and
# prints PASS or FAIL per item with the number it measured. It changes
# nothing — every statement is a SELECT.
#
# Exit 0 = every check passed. Exit 1 = at least one failed, and the
# failures are repeated at the end.
#
# ---------------------------------------------------------------------------
# WHAT "LIVE" MEANS HERE
#
#   fetchPayerRule() serves a rule when
#
#     effective_date <= dos AND (expiration_date IS NULL OR expiration_date > dos)
#
#   Not `expiration_date IS NULL`, which is what every check in this file used
#   to say. The two are different sets: a rule given a FUTURE expiration_date —
#   the normal way to schedule an annual sunset — is served in production and
#   invisible to an IS NULL test, and a rule with a future effective_date is not
#   served even though IS NULL calls it live. Every count below now uses the
#   real predicate, at a date of service that defaults to CURRENT_DATE and is
#   overridable with AUDIT_DOS=YYYY-MM-DD.
#
# CHECKS THAT CANNOT FAIL ARE NOT PRINTED AS PASSES
#
#   Two items here used to print PASS and count toward "passed: N" while the
#   schema already made the failure impossible:
#
#     * "rules citing a document that does not exist" — source_doc_id is
#       NOT NULL with a foreign key to source_document.
#     * "expiration_date earlier than effective_date" — enforced by the
#       payer_rule_check CHECK constraint.
#
#   They are now printed as STRC with the constraint that enforces them and
#   excluded from the tally. A reader must not be able to mistake "the column
#   has a foreign key" for "somebody verified 5,700 rows". If the constraint is
#   ever dropped the line degrades into a real, counted check on the spot.
#
# RUNNING IT SOMEWHERE OTHER THAN THE VPS
#
#   PG_DB=billing_rules PSQL_BIN="psql -h localhost -U postgres" \
#     bash scripts/verify-production.sh
#
#   Sections 1 and 3 assume the production deploy ledger and migration 0068
#   journal exist; they FAIL loudly rather than silently pass if they do not.
# ---------------------------------------------------------------------------

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/pallio/app}"
PG_DB="${PG_DB:-pallio}"
PSQL_BIN="${PSQL_BIN:-sudo -u postgres psql}"

# The root check exists because `sudo -u postgres` needs it. When PSQL_BIN has
# been overridden to a direct connection, it does not apply.
case "$PSQL_BIN" in
  sudo*) [ "$(id -u)" = "0" ] || { echo "FATAL: run with sudo (needs the postgres role)"; exit 1; } ;;
esac

# APP_DIR only matters for section 6 (the tsx service check). Not being able to
# cd there is not fatal for the SQL checks; section 6 reports SKIP.
cd "$APP_DIR" 2>/dev/null || echo "  note  $APP_DIR not found - section 6 (service check) will SKIP"

AUDIT_DOS="${AUDIT_DOS:-}"
if [ -n "$AUDIT_DOS" ]; then
  case "$AUDIT_DOS" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) echo "FATAL: AUDIT_DOS must be YYYY-MM-DD, got '$AUDIT_DOS'"; exit 1 ;;
  esac
  DOS_SQL="DATE '$AUDIT_DOS'"
else
  DOS_SQL="CURRENT_DATE"
fi

# The one definition of live in this file.
SERVED="effective_date <= $DOS_SQL AND (expiration_date IS NULL OR expiration_date > $DOS_SQL)"

# Q returns the scalar, or "ERR:<first line of the postgres error>".
#
# This used to be `psql ... 2>/dev/null | tr -d [:space:]`, which turned every
# failed query into an empty string. A missing table then printed
# "got=<none> want=1" — indistinguishable from a ledger that exists and is
# empty. Those are completely different facts about a deploy, and a verifier
# that cannot tell them apart is guessing. check() now says QUERY FAILED and
# prints what postgres actually said.
Q() {
  local out rc
  out="$($PSQL_BIN -X -tAq -d "$PG_DB" -c "$1" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'ERR:%s' "$(printf '%s' "$out" | tr -d '\r' | grep -v '^$' | head -1 | cut -c1-88)"
    return 0
  fi
  printf '%s' "$out" | tr -d '[:space:]'
}
QT() { $PSQL_BIN -X -q -d "$PG_DB" -c "$1" 2>&1; }

PASS=0
FAIL=0
STRUCT=0
FAILURES=""

# check <label> <expected> <actual>   — expected "0", a number, or "gt:N"
check() {
  local label="$1" want="$2" got="$3" ok=0
  case "$got" in
    ERR:*)
      printf '  FAIL  %-58s %s\n' "$label" "QUERY FAILED"
      printf '        %s\n' "${got#ERR:}"
      FAIL=$((FAIL + 1))
      FAILURES="$FAILURES\n  - $label (query failed: ${got#ERR:})"
      return ;;
  esac
  case "$want" in
    gt:*) [ "${got:-0}" -gt "${want#gt:}" ] 2>/dev/null && ok=1 ;;
    *)    [ "${got:-}" = "$want" ] && ok=1 ;;
  esac
  if [ "$ok" = "1" ]; then
    printf '  PASS  %-58s %s\n' "$label" "$got"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %-58s got=%s want=%s\n' "$label" "${got:-<none>}" "$want"
    FAIL=$((FAIL + 1))
    FAILURES="$FAILURES\n  - $label (got ${got:-<none>}, want $want)"
  fi
}

# guarantee <label> <constraint-name> <notnull-col|-> <count-sql>
#
# A property the schema already forbids violating. Printed so it is visible,
# labelled STRC so nobody reads it as an independent assurance, and NOT counted.
# If the enforcement is gone it becomes a real, counted check immediately.
guarantee() {
  local label="$1" cname="$2" col="$3" count_sql="$4" cdef notnull
  cdef="$(Q "SELECT count(*) FROM pg_constraint
              WHERE conrelid='payer_rule'::regclass AND conname='$cname'")"
  if [ "$col" = "-" ]; then
    notnull="yes"
  else
    notnull="$(Q "SELECT CASE WHEN bool_and(attnotnull) THEN 'yes' ELSE 'no' END
                    FROM pg_attribute
                   WHERE attrelid='payer_rule'::regclass AND attname='$col'")"
  fi
  if [ "${cdef:-0}" = "1" ] && [ "$notnull" = "yes" ]; then
    printf '  STRC  %-58s %s\n' "$label" "schema"
    printf '        enforced by %s%s\n' "$cname" \
      "$( [ "$col" = "-" ] || printf ' + %s NOT NULL' "$col" )"
    printf '        cannot fail -> restated, NOT evidence, NOT counted\n'
    STRUCT=$((STRUCT + 1))
    return
  fi
  printf '  !!!!  %-58s %s\n' "$label" "ENFORCEMENT GONE"
  printf '        %s missing - this is a REAL check now:\n' "$cname"
  check "$label" 0 "$(Q "$count_sql")"
}

echo ""
echo "=== 1. Did the deploy actually run? ==============================="

check "migration 0068 recorded in the ledger" 1 \
  "$(Q "SELECT count(*) FROM schema_migration WHERE filename = '0068_dedupe_source_document.sql'")"
check "migrations 0066 + 0067 recorded" 2 \
  "$(Q "SELECT count(*) FROM schema_migration WHERE filename IN ('0066_rule_library_observability.sql','0067_expand_coverage_targets.sql')")"
check "seed ledger exists and is populated" gt:20 \
  "$(Q "SELECT count(*) FROM seed_application")"
check "round-2 denial seed applied" 1 \
  "$(Q "SELECT count(*) FROM seed_application WHERE filename = 'payer-rules-denial-attributes-2.sql'")"
check "UHC/Anthem ingestion sources seed applied" 1 \
  "$(Q "SELECT count(*) FROM seed_application WHERE filename = 'ingestion-sources-uhc-anthem-oh.sql'")"

echo ""
echo "=== 2. Rule-library integrity ====================================="

# The invariant the whole lookup depends on: fetchPayerRule ends in
# LIMIT 1 with no confidence tiebreak, so a second live row on a key makes
# the answer depend on row order.
echo "  live = effective_date <= DOS AND (expiration_date IS NULL OR expiration_date > DOS)"
echo "  DOS  = $(Q "SELECT ($DOS_SQL)::text")   (override with AUDIT_DOS=YYYY-MM-DD)"
echo ""

check "duplicate LIVE rules per (payer,state,code,attribute)" 0 \
  "$(Q "SELECT count(*) FROM (SELECT payer_id,state,code,attribute FROM payer_rule WHERE $SERVED GROUP BY 1,2,3,4 HAVING count(*)>1) d")"

# The same invariant at the dates a denial is actually re-worked at. A claim
# inside the timely-filing window is looked up at the DOS on the CLAIM, where a
# DIFFERENT set of rows is served. `expiration_date IS NULL` has no notion of a
# date and cannot ask this at all. DISTINCT keys, so a key ambiguous at two
# dates counts once.
check "...same, at a DOS 90/180/365 days back" 0 \
  "$(Q "SELECT count(*) FROM (
          SELECT DISTINCT payer_id,state,code,attribute FROM (
            SELECT b.dos, r.payer_id, r.state, r.code, r.attribute
              FROM (VALUES ($DOS_SQL-90),($DOS_SQL-180),($DOS_SQL-365)) b(dos)
              JOIN payer_rule r
                ON r.effective_date <= b.dos
               AND (r.expiration_date IS NULL OR r.expiration_date > b.dos)
             GROUP BY 1,2,3,4,5 HAVING count(*)>1) u) k")"

guarantee "rules citing a document that does not exist" \
  payer_rule_source_doc_id_fkey source_doc_id \
  "SELECT count(*) FROM payer_rule r WHERE r.source_doc_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id=r.source_doc_id)"

guarantee "expiration_date earlier than effective_date" \
  payer_rule_check - \
  "SELECT count(*) FROM payer_rule WHERE expiration_date IS NOT NULL AND expiration_date < effective_date"

check "live rules total" gt:5000 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE $SERVED")"
echo "  note  rows matching the OLD, WRONG test 'expiration_date IS NULL': $(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NULL")"
echo "  note  served now but invisible to that test (future expiration_date): $(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NOT NULL AND expiration_date > $DOS_SQL AND effective_date <= $DOS_SQL")"

echo ""
echo "=== 3. Document dedup (migration 0068) ============================"

check "duplicate (url,payer_id,content_hash) triples" 0 \
  "$(Q "SELECT count(*) FROM (SELECT 1 FROM source_document GROUP BY url, coalesce(payer_id::text,'~null~'), content_hash HAVING count(*)>1) d")"
# Either form counts: the constraint on PostgreSQL 15+, or the expression
# index on older servers. Summed IN SQL — two separate $(Q ...) calls side
# by side CONCATENATE their output, so a present constraint (1) and an
# absent index (0) read as "10" and failed a check that should have passed.
check "uniqueness constraint present on source_document" 1 \
  "$(Q "SELECT (SELECT count(*) FROM pg_constraint WHERE conname='source_document_url_payer_hash_key')
             + (SELECT count(*) FROM pg_class     WHERE relname='source_document_url_payer_hash_uniq')")"
echo "  note  documents merged by 0068 on this database: $(Q "SELECT count(*) FROM migration_0068_document_merge_journal")"
echo "  note  documents on more than one row — expected for a policy serving"
echo "        several payers, and for a watched document with real versions:"
$PSQL_BIN -X -q -d "$PG_DB" -c \
  "SELECT count(DISTINCT payer_id) AS payers, count(*) AS rows, left(url,52) AS url
     FROM source_document GROUP BY url HAVING count(*)>1 ORDER BY 2 DESC;" 2>/dev/null

# VERSION CHURN. A row per (url, payer, content_hash) is correct — that is
# how a changed document is recorded. But an HTML page whose bytes differ
# on every fetch (timestamps, ad slots, session ids) mints a NEW version
# each crawl, and each one can trigger a fresh extraction. Many versions
# of ONE document under ONE payer is that, not real change. Reported, not
# failed: it is a property of the source, not of this deploy.
CHURN="$(Q "SELECT count(*) FROM (SELECT url, payer_id FROM source_document GROUP BY url, payer_id HAVING count(*) >= 5) d")"
if [ "${CHURN:-0}" = "0" ]; then
  printf '  PASS  %-58s %s\n' "documents with runaway version churn (>=5 per payer)" "0"
  PASS=$((PASS + 1))
else
  printf '  WARN  %-58s %s\n' "documents with >=5 versions for ONE payer" "$CHURN"
  echo "        Each version can cost a re-extraction. Worth checking whether"
  echo "        these pages genuinely change or just differ byte-to-byte."
  $PSQL_BIN -X -q -d "$PG_DB" -c \
    "SELECT count(*) AS versions,
            min(retrieved_at)::date AS first_seen,
            max(retrieved_at)::date AS last_seen,
            left(url, 58) AS url
       FROM source_document
      GROUP BY url, payer_id HAVING count(*) >= 5
      ORDER BY 1 DESC;" 2>/dev/null
fi

echo ""
echo "=== 4. The rules the client asked for ============================="

UHC='a0000000-0000-4000-8000-000000000302'
ANTHEM='a0000000-0000-4000-8000-000000000303'

check "UHC Ohio  prior_auth_required rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='prior_auth_required' AND $SERVED")"
check "UHC Ohio  provider_taxonomy_allowed rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='provider_taxonomy_allowed' AND $SERVED")"
check "UHC Ohio  frequency_limit rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='frequency_limit' AND $SERVED")"
check "UHC Ohio  documentation_required rules" 14 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='documentation_required' AND $SERVED")"
check "Anthem OH prior_auth_required rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$ANTHEM' AND attribute='prior_auth_required' AND $SERVED")"

# The mapping error the auditor exists to catch: a home health AGENCY rule
# attached to physician home visits. Anthem's "skilled nursing after 18
# combined visits" is an agency benefit; if it were ever read as governing
# 99341-99350, a biller would be told every home visit needs prior auth.
#
# The rules that legitimately QUOTE that phrase are the ones excluding it
# from scope, and they always say so with "home health agency". So the
# defect is the phrase WITHOUT that disclaimer — an earlier version of
# this check looked for "does not" instead and flagged all 8 correct rules.
check "home-health-agency rule wrongly on a physician home visit" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE $SERVED AND code IN ('99341','99342','99344','99345','99347','99348','99349','99350') AND value->>'answer' ILIKE '%18 combined visits%' AND value->>'answer' NOT ILIKE '%home health agency%'")"

# 99343 was deleted from CPT effective 2023-01-01. A rule SAYING SO is
# correct and useful — Ohio Medicaid's Appendix DD carries it as
# discontinued, and a biller asking "can I bill 99343?" should be told no.
# The defect would be the opposite: a live rule calling it covered.
check "retired code 99343 marked COVERED" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE code='99343' AND $SERVED AND coverage_status='covered'")"

# ---------------------------------------------------------------------------
# A LIVE RULE THAT NO SEED PRODUCES IS NOT REALLY IN THE LIBRARY
#
# db/seed/MANIFEST is what builds a database. A rule whose created_by appears
# in no seed file cannot be rebuilt: production, which is built by running the
# manifest, will not have it, and replay-from-scratch will not reproduce it.
# It exists only in whichever database the ad-hoc run happened to touch.
#
# This is not hypothetical. 'extract:state-fee-schedule-2026-08' put 113 rows
# in one developer database, 12 of them live and answering — 99343, G0179 and
# G0180 for four Ohio Medicaid plans. Locally the library answered all three.
# Production had never heard of them. Every local check that read those cells
# passed on data that existed nowhere else, and reported coverage the product
# did not have. Nothing here caught it; it surfaced only because a migration
# reported 8 rows repaired locally and 0 on production.
#
# Rules are compared by AUTHOR rather than by row because a seed's rows are
# generated, so the author string is the only stable thing a file and a table
# share.
#
# NOTE: this deliberately does NOT use Q(). Q ends in `tr -d '[:space:]'`,
# which strips newlines as well as padding, so a multi-row result arrives as
# one concatenated string. Q is for scalars only. The first version of this
# check used it, read a single mangled line, matched the first author and
# reported 0 orphans while an orphan was sitting in the table — a check that
# silently could not fail. It is read row by row from psql directly instead.
ORPHAN_ROWS=0
ORPHAN_LIST=""
while IFS='|' read -r _author _n; do
  _author="$(printf '%s' "$_author" | tr -d '\r')"
  _n="$(printf '%s' "$_n" | tr -cd '0-9')"
  [ -z "$_author" ] && continue
  [ -z "$_n" ] && continue
  if ! grep -rqF -- "$_author" db/seed/ 2>/dev/null; then
    ORPHAN_ROWS=$((ORPHAN_ROWS + _n))
    ORPHAN_LIST="$ORPHAN_LIST
    $_author  ($_n live rule(s))"
  fi
done <<EOF
$($PSQL_BIN -X -tAq -d "$PG_DB" -c "SELECT created_by||'|'||count(*) FROM payer_rule WHERE $SERVED GROUP BY created_by ORDER BY 1" 2>/dev/null)
EOF
check "live rules no seed in db/seed/ can reproduce" 0 "$ORPHAN_ROWS"
if [ "$ORPHAN_ROWS" != "0" ]; then
  echo "        these authors appear in payer_rule but in no seed file:$ORPHAN_LIST"
  echo "        commit the extraction as a seed, or withdraw the rows."
fi

# ---------------------------------------------------------------------------
# ONE DOCUMENT MUST NOT PRODUCE TWO ANSWERS
#
# All five Ohio Medicaid plans are governed by the same state document,
# Appendix DD to rule 5160-1-60. For a code the schedule does not list at all,
# every plan must therefore reach the same conclusion. G0179, G0180 and G0181
# are all absent from all eight tabs, and all three fall inside G0001-G9999 —
# the first range named by the schedule's blanket exclusion note, which denies
# unlisted codes in the ranges it enumerates. So all three are not_covered on
# all five plans, and 99343 is not_covered because the schedule carries it with
# status code 3, discontinued coverage, since 01/01/2023.
#
# The library once held G0179/G0180 as not_covered and G0181 as unknown, from
# that same sentence, because the seed that wrote G0181 claimed these codes
# "cannot be shown to fall inside" the enumerated ranges. G0181 falls inside
# the first one. Nothing failed — both answers were well-formed and unique.
# A disagreement between plans reading one document is the detectable symptom.
check "Ohio Appendix DD absent/discontinued codes not uniformly denied" 0 \
  "$(Q "SELECT count(*) FROM payer_rule r JOIN payer p ON p.id = r.payer_id
         WHERE r.state='OH' AND r.attribute='covered' AND r.product_line='medicaid_mco'
           AND r.code IN ('99343','G0179','G0180','G0181') AND $SERVED
           AND r.coverage_status <> 'not_covered'")"
check "Ohio Appendix DD absent/discontinued codes answered by all 5 plans" 20 \
  "$(Q "SELECT count(*) FROM payer_rule r
         WHERE r.state='OH' AND r.attribute='covered' AND r.product_line='medicaid_mco'
           AND r.code IN ('99343','G0179','G0180','G0181') AND $SERVED")"

# G0318, prolonged home E/M, IS listed on Appendix DD — status code 1, with a
# non-facility rate — so unlike the four above it must come back covered, on
# every Ohio Medicaid plan. It is called out separately because it is the code
# the reverted seed did the most damage to: it was downgraded to 'unknown' on
# all five plans and served that way for two deploys.
check "Ohio Medicaid plans answering G0318 as covered" 5 \
  "$(Q "SELECT count(*) FROM payer_rule r
         WHERE r.state='OH' AND r.attribute='covered' AND r.product_line='medicaid_mco'
           AND r.code='G0318' AND coverage_status='covered' AND $SERVED")"

# ---------------------------------------------------------------------------
# A BUNDLED CODE MUST NOT REACH THE PICKER UNANNOUNCED
#
# Fee schedules mark some codes bundled — Ohio's Appendix DD spells indicator
# B as "BUNDLED PROCEDURE WITH NO SEPARATE PAYMENT", and Medicare's RVU file
# uses status code B the same way. Billing one is not a denial; it pays zero.
# 101 live rules are in that state and every one of them records it correctly
# in its prose answer.
#
# The picker, though, shows the status badge and the citation, not the answer.
# A bundled code appearing there would read 'varies' beside a quote ending
# "| payment B", and the key that decodes B is in the payer's spreadsheet
# rather than anywhere in this app.
#
# Today that cannot happen: payer_allowed_codes_v joins the `code` catalog,
# which is the 112 in-scope codes, and all 14 bundled codes (99377, 99379,
# 99380, 99358, 99359, 99366-99368, 99374, 99485, 99486, 99288, 36416, G0269)
# sit outside it. So this is a tripwire, not a repair — it holds at 0 for free
# and fires the day scope grows to include one, which is the day the picker
# needs a way to say "bundled" out loud.
#
# I built that badge before measuring this, and it could never have rendered.
# The measurement is the check.
check "bundled codes reaching the picker with no way to say so" 0 \
  "$(Q "SELECT count(*) FROM payer_allowed_codes_v
         WHERE coverage_status = ANY(ARRAY['covered','varies'])
           AND (source_quote ~ '\| payment B\s*\$' OR source_quote ~ 'status code B\y')")"

# ---------------------------------------------------------------------------
# A REPAIR MUST NOT LEAVE A HOLE WHERE IT FOUND A WRONG ANSWER
#
# migration_0074_purge_journal records every rule removed when the reverted
# Ohio seed was purged. Each of those rows occupied a key that was being
# answered — wrongly, but answered. After the purge, the repair, the seeds and
# the maintenance scripts have all run, every one of those keys must answer
# again. Silence is not an improvement on a wrong answer: the picker simply
# shows nothing and the biller learns nothing.
#
# This is generic on purpose. The specific failure it was written for is that
# 0074 revived whatever rule was newest without checking the author, picked a
# hand-typed rule for UnitedHealthcare Community Plan Ohio on G0318, and
# expire-ungrounded-rules then withdrew it — correctly — leaving that key dark
# while the real determination sat expired underneath. Every other check in
# this file passed on that deploy, including the two added directly above it.
check "keys emptied by the 0074 purge that still answer nothing" 0 \
  "$(Q "SELECT CASE WHEN to_regclass('public.migration_0074_purge_journal') IS NULL THEN 0 ELSE (
           SELECT count(*) FROM (
             SELECT DISTINCT (rule_row->>'payer_id')::uuid AS payer_id, rule_row->>'state' AS state,
                    rule_row->>'code' AS code, rule_row->>'attribute' AS attribute,
                    rule_row->>'product_line' AS product_line
               FROM migration_0074_purge_journal) k
            WHERE NOT EXISTS (
              SELECT 1 FROM payer_rule live
               WHERE live.payer_id IS NOT DISTINCT FROM k.payer_id
                 AND live.state IS NOT DISTINCT FROM k.state
                 AND live.code = k.code AND live.attribute = k.attribute
                 AND live.product_line IS NOT DISTINCT FROM k.product_line
                 AND live.effective_date <= $DOS_SQL
                 AND (live.expiration_date IS NULL OR live.expiration_date > $DOS_SQL))) END")"

# Every extracted rule must cite a verbatim sentence — that is the
# library's core discipline and what a biller uses in an appeal.
check "extracted live rules with no source_quote" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE $SERVED AND created_by LIKE 'extract:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"
check "crawled live rules with no source_quote" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE $SERVED AND created_by LIKE 'crawler:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"

# A quote is only worth as much as the document a biller can open to check
# it. source_document still holds a row for
# 'https://example.test/anthem-oh-palliative-policy.pdf' — a fixture URL
# registered as a real Anthem policy, predating the seed-document check
# that now rejects exactly this. Nothing cites it today, so this guard is
# currently proving a zero rather than reporting a problem; it exists so
# that if a rule ever DOES cite an unopenable URL, it is caught here
# instead of in front of a biller mid-appeal.
# $SERVED names effective_date/expiration_date unqualified, and
# source_document has an effective_date too — so the predicate must be
# spelled out here rather than reused, or the join makes it ambiguous and
# the check reports QUERY FAILED instead of a number.
check "live rules citing a URL nobody can open" 0 \
  "$(Q "SELECT count(*) FROM payer_rule r JOIN source_document d ON d.id = r.source_doc_id
         WHERE r.effective_date <= $DOS_SQL
           AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL)
           AND (d.url LIKE '%example.test%' OR d.url LIKE '%fixture%'
                OR d.url LIKE '%localhost%' OR d.url LIKE 'upload://%'
                OR d.url NOT LIKE 'http%')")"
# Older hand-inserted rows are reported, not failed: they predate the
# grounding rule and cannot be fixed from here, but a biller opening one
# gets an empty citation panel, so somebody should know the number.
UNSOURCED="$(Q "SELECT count(*) FROM payer_rule WHERE $SERVED AND created_by NOT LIKE 'extract:%' AND created_by NOT LIKE 'crawler:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"
if [ "${UNSOURCED:-0}" = "0" ]; then
  printf '  PASS  %-58s %s\n' "legacy live rules with no source_quote" "0"
  PASS=$((PASS + 1))
else
  printf '  WARN  %-58s %s  (pre-existing, not from this work)\n' "legacy live rules with no source_quote" "$UNSOURCED"
  $PSQL_BIN -X -q -d "$PG_DB" -c \
    "SELECT p.name AS payer, r.code, r.attribute, r.created_by
       FROM payer_rule r LEFT JOIN payer p ON p.id = r.payer_id
      WHERE r.effective_date <= $DOS_SQL AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL) AND r.created_by NOT LIKE 'extract:%'
        AND r.created_by NOT LIKE 'crawler:%'
        AND (r.source_quote IS NULL OR length(trim(r.source_quote)) = 0);" 2>/dev/null
fi

# The check above asks for a non-pipeline author AND a missing source_quote.
# Seven rules authored by 'test@pallio.io' passed it for months because they
# HAVE quotes -- typed by hand, along with the answers. They sat on Aetna and
# Anthem BCBS Ohio, on real palliative codes, five of them holding `covered`,
# at confidence 0.93-0.95 (above every real extraction), and fetchPayerRule's
# LIMIT 1 made each one THE answer for its key.
#
# So the author alone is the test. Every legitimate rule in this library is
# created by a run that names itself -- extract:<batch> or crawler:<source>.
# A person's name in created_by means a human typed a payer rule, and no
# amount of well-formedness makes that citable.
check "live rules whose author is not an extraction run" "0" \
  "$(Q "SELECT count(*) FROM payer_rule
         WHERE effective_date <= $DOS_SQL
           AND (expiration_date IS NULL OR expiration_date > $DOS_SQL)
           AND created_by NOT LIKE 'extract:%'
           AND created_by NOT LIKE 'crawler:%'")"
if [ "$(Q "SELECT count(*) FROM payer_rule WHERE effective_date <= $DOS_SQL AND (expiration_date IS NULL OR expiration_date > $DOS_SQL) AND created_by NOT LIKE 'extract:%' AND created_by NOT LIKE 'crawler:%'")" != "0" ]; then
  $PSQL_BIN -X -q -d "$PG_DB" -c \
    "SELECT p.name AS payer, r.code, r.attribute, r.created_by, r.confidence
       FROM payer_rule r LEFT JOIN payer p ON p.id = r.payer_id
      WHERE r.effective_date <= $DOS_SQL AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL)
        AND r.created_by NOT LIKE 'extract:%' AND r.created_by NOT LIKE 'crawler:%'
      ORDER BY r.created_by, p.name, r.code;" 2>/dev/null
  echo "        db/maintenance/expire-ungrounded-rules.sql withdraws known-bad authors."
  echo "        An author not on its denylist is a decision for a human, not a script."
fi

echo ""
echo "=== 5. Denial-scorer attribute coverage ==========================="
$PSQL_BIN -X -q -d "$PG_DB" -c \
  "SELECT attribute, count(*) AS live_rules, count(DISTINCT payer_id) AS payers
     FROM payer_rule WHERE effective_date <= $DOS_SQL AND (expiration_date IS NULL OR expiration_date > $DOS_SQL)
      AND attribute IN ('covered','prior_auth_required','modifier_required','frequency_limit')
    GROUP BY 1 ORDER BY 2 DESC;" 2>/dev/null

# The counts above say the RULES exist. They say nothing about whether the
# scorer can act on them, and for frequency it could not: denial-risk.
# service.ts gates its whole frequency_exceeded check (weight 0.75) on
# value->'maxOccurrences' and value->'windowDays' being present, and those
# two keys live INSIDE payer_rule.value on rows the seeds own. Migration
# 0070 added them once; the next seed replay's ON CONFLICT ... DO UPDATE
# SET value = EXCLUDED.value replaced the whole object and deleted them,
# and a migration never runs again to restore it. Production ran with 150
# frequency_limit rules and 0 usable caps, and every count-based check on
# this page still read green. This is the check that would have caught it.
# A zero here means backfill-structured-scorer-fields.sql did not run, or a
# seed overwrote value after it did.
check "frequency rules carrying usable caps (scorer can act)" "gt:0" \
  "$(Q "SELECT count(*) FROM payer_rule
         WHERE attribute = 'frequency_limit'
           AND effective_date <= $DOS_SQL
           AND (expiration_date IS NULL OR expiration_date > $DOS_SQL)
           AND jsonb_typeof(value->'maxOccurrences') = 'number'
           AND jsonb_typeof(value->'windowDays')     = 'number'")"

echo ""
echo "=== 6. Live lookup through the real service ======================="
# The SQL above proves the rows exist. This proves lookupRule() returns
# them — which is what a nurse practitioner actually sees.
# Deliberately NOT via npx. On a VPS `npx dotenv-cli` and `npx tsx` try to
# DOWNLOAD those packages, which on a box with no npm cache hangs with no
# output — this step sat there indefinitely on its first production run.
# Use the tsx that npm ci already installed, or skip and say so. And read
# DATABASE_URL out of the env file directly rather than shelling out to
# dotenv-cli for it.
# node_modules/.bin/tsx is a SHELL WRAPPER, not JavaScript — running it as
# `node .bin/tsx` dies on `basedir=$(dirname ...)`. Prefer the real JS
# entry point for node; fall back to executing the wrapper directly.
TSX_NODE=""
TSX_EXEC=""
if [ -f ./node_modules/tsx/dist/cli.mjs ]; then
  TSX_NODE=./node_modules/tsx/dist/cli.mjs
elif [ -x ./node_modules/.bin/tsx ]; then
  TSX_EXEC=./node_modules/.bin/tsx
fi
ENVFILE=""
for f in .env.production .env .env.local; do [ -f "$f" ] && ENVFILE="$f" && break; done

if [ -z "$TSX_NODE" ] && [ -z "$TSX_EXEC" ]; then
  echo "  SKIP  tsx not found under node_modules. The SQL checks above already"
  echo "        prove the rows exist; this step proves the SERVICE returns them."
  echo "        Run 'npm ci' to enable it."
elif [ -z "$ENVFILE" ]; then
  echo "  SKIP  no .env file found — cannot reach the database as the app does"
else
  DBURL="$(grep -E '^DATABASE_URL=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  if [ -z "$DBURL" ]; then
    echo "  SKIP  no DATABASE_URL in $ENVFILE"
  else
    # A hard timeout so a hung query can never wedge the whole check.
    # 300s, not 180: tsx compiles the service graph on a cold start, and
    # the VPS is slower than a laptop.
    if [ -n "$TSX_NODE" ]; then
      set -- node "$TSX_NODE"
    else
      set -- "$TSX_EXEC"
    fi
    if DATABASE_URL="$DBURL" timeout 300 "$@" scripts/verify-denial-rules-round2.ts 2>&1 | tail -20; then
      PASS=$((PASS + 1))
      echo "  PASS  lookupRule() returned the expected answers"
    else
      rc=$?
      FAIL=$((FAIL + 1))
      [ "$rc" = "124" ] && msg="lookupRule() check timed out after 300s" \
                        || msg="lookupRule() did not return the expected answers"
      FAILURES="$FAILURES\n  - $msg"
      echo "  FAIL  $msg"
    fi
  fi
fi

echo ""
echo "=================================================================="
printf 'checks that could have failed: %s   passed: %s   failed: %s\n' \
  "$((PASS + FAIL))" "$PASS" "$FAIL"
printf 'structural guarantees restated (NOT counted, NOT evidence): %s\n' "$STRUCT"
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILURES:%b\n' "$FAILURES"
  echo ""
  echo "Do not tell the client this is done. Send the output above."
  exit 1
fi
echo "Production matches what was verified locally."
exit 0
