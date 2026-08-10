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

# Every extracted rule must cite a verbatim sentence — that is the
# library's core discipline and what a biller uses in an appeal.
check "extracted live rules with no source_quote" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE $SERVED AND created_by LIKE 'extract:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"
check "crawled live rules with no source_quote" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE $SERVED AND created_by LIKE 'crawler:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"
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

echo ""
echo "=== 5. Denial-scorer attribute coverage ==========================="
$PSQL_BIN -X -q -d "$PG_DB" -c \
  "SELECT attribute, count(*) AS live_rules, count(DISTINCT payer_id) AS payers
     FROM payer_rule WHERE effective_date <= $DOS_SQL AND (expiration_date IS NULL OR expiration_date > $DOS_SQL)
      AND attribute IN ('covered','prior_auth_required','modifier_required','frequency_limit')
    GROUP BY 1 ORDER BY 2 DESC;" 2>/dev/null

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
TSX=""
for c in ./node_modules/.bin/tsx ./node_modules/tsx/dist/cli.mjs; do
  [ -x "$c" ] || [ -f "$c" ] && TSX="$c" && break
done
ENVFILE=""
for f in .env.production .env .env.local; do [ -f "$f" ] && ENVFILE="$f" && break; done

if [ -z "$TSX" ]; then
  echo "  SKIP  tsx not installed locally (node_modules/.bin/tsx). The SQL checks"
  echo "        above already prove the rows exist; this step proves the SERVICE"
  echo "        returns them. Run 'npm ci' to enable it."
elif [ -z "$ENVFILE" ]; then
  echo "  SKIP  no .env file found — cannot reach the database as the app does"
else
  DBURL="$(grep -E '^DATABASE_URL=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  if [ -z "$DBURL" ]; then
    echo "  SKIP  no DATABASE_URL in $ENVFILE"
  else
    # A hard timeout so a hung query can never wedge the whole check.
    if DATABASE_URL="$DBURL" timeout 180 node "$TSX" scripts/verify-denial-rules-round2.ts 2>&1 | tail -20; then
      PASS=$((PASS + 1))
      echo "  PASS  lookupRule() returned the expected answers"
    else
      rc=$?
      FAIL=$((FAIL + 1))
      [ "$rc" = "124" ] && msg="lookupRule() check timed out after 180s" \
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
