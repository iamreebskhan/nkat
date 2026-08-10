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

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/pallio/app}"
PG_DB="${PG_DB:-pallio}"

cd "$APP_DIR" 2>/dev/null || { echo "FATAL: $APP_DIR not found"; exit 1; }
[ "$(id -u)" = "0" ] || { echo "FATAL: run with sudo (needs the postgres role)"; exit 1; }

Q() { sudo -u postgres psql -X -tAq -d "$PG_DB" -c "$1" 2>/dev/null | tr -d '[:space:]'; }

PASS=0
FAIL=0
FAILURES=""

# check <label> <expected> <actual>   — expected "0", a number, or "gt:N"
check() {
  local label="$1" want="$2" got="$3" ok=0
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
check "duplicate LIVE rules per (payer,state,code,attribute)" 0 \
  "$(Q "SELECT count(*) FROM (SELECT payer_id,state,code,attribute FROM payer_rule WHERE expiration_date IS NULL GROUP BY 1,2,3,4 HAVING count(*)>1) d")"
check "rules citing a document that does not exist" 0 \
  "$(Q "SELECT count(*) FROM payer_rule r WHERE r.source_doc_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id=r.source_doc_id)")"
check "expiration_date earlier than effective_date" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NOT NULL AND expiration_date < effective_date")"
check "live rules total" gt:5000 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NULL")"

echo ""
echo "=== 3. Document dedup (migration 0068) ============================"

check "duplicate (url,payer_id,content_hash) triples" 0 \
  "$(Q "SELECT count(*) FROM (SELECT 1 FROM source_document GROUP BY url, coalesce(payer_id::text,'~null~'), content_hash HAVING count(*)>1) d")"
check "uniqueness constraint present on source_document" 1 \
  "$(Q "SELECT count(*) FROM pg_constraint WHERE conname='source_document_url_payer_hash_key'")$(Q "SELECT count(*) FROM pg_class WHERE relname='source_document_url_payer_hash_uniq'")"
echo "  note  documents merged by 0068 on this database: $(Q "SELECT count(*) FROM migration_0068_document_merge_journal")"
echo "  note  multi-payer documents left intact (same url, different payers):"
sudo -u postgres psql -X -q -d "$PG_DB" -c \
  "SELECT count(DISTINCT payer_id) AS payers, count(*) AS rows, left(url,52) AS url
     FROM source_document GROUP BY url HAVING count(*)>1 ORDER BY 2 DESC;" 2>/dev/null

echo ""
echo "=== 4. The rules the client asked for ============================="

UHC='a0000000-0000-4000-8000-000000000302'
ANTHEM='a0000000-0000-4000-8000-000000000303'

check "UHC Ohio  prior_auth_required rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='prior_auth_required' AND expiration_date IS NULL")"
check "UHC Ohio  provider_taxonomy_allowed rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='provider_taxonomy_allowed' AND expiration_date IS NULL")"
check "UHC Ohio  frequency_limit rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='frequency_limit' AND expiration_date IS NULL")"
check "UHC Ohio  documentation_required rules" 14 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$UHC' AND attribute='documentation_required' AND expiration_date IS NULL")"
check "Anthem OH prior_auth_required rules" 25 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE payer_id='$ANTHEM' AND attribute='prior_auth_required' AND expiration_date IS NULL")"

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
  "$(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NULL AND code IN ('99341','99342','99344','99345','99347','99348','99349','99350') AND value->>'answer' ILIKE '%18 combined visits%' AND value->>'answer' NOT ILIKE '%home health agency%'")"

# 99343 was deleted from CPT effective 2023-01-01. A rule SAYING SO is
# correct and useful — Ohio Medicaid's Appendix DD carries it as
# discontinued, and a biller asking "can I bill 99343?" should be told no.
# The defect would be the opposite: a live rule calling it covered.
check "retired code 99343 marked COVERED" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE code='99343' AND expiration_date IS NULL AND coverage_status='covered'")"

# Every extracted rule must cite a verbatim sentence — that is the
# library's core discipline and what a biller uses in an appeal.
check "extracted live rules with no source_quote" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NULL AND created_by LIKE 'extract:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"
check "crawled live rules with no source_quote" 0 \
  "$(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NULL AND created_by LIKE 'crawler:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"
# Older hand-inserted rows are reported, not failed: they predate the
# grounding rule and cannot be fixed from here, but a biller opening one
# gets an empty citation panel, so somebody should know the number.
UNSOURCED="$(Q "SELECT count(*) FROM payer_rule WHERE expiration_date IS NULL AND created_by NOT LIKE 'extract:%' AND created_by NOT LIKE 'crawler:%' AND (source_quote IS NULL OR length(trim(source_quote))=0)")"
if [ "${UNSOURCED:-0}" = "0" ]; then
  printf '  PASS  %-58s %s\n' "legacy live rules with no source_quote" "0"
  PASS=$((PASS + 1))
else
  printf '  WARN  %-58s %s  (pre-existing, not from this work)\n' "legacy live rules with no source_quote" "$UNSOURCED"
  sudo -u postgres psql -X -q -d "$PG_DB" -c \
    "SELECT p.name AS payer, r.code, r.attribute, r.created_by
       FROM payer_rule r LEFT JOIN payer p ON p.id = r.payer_id
      WHERE r.expiration_date IS NULL AND r.created_by NOT LIKE 'extract:%'
        AND r.created_by NOT LIKE 'crawler:%'
        AND (r.source_quote IS NULL OR length(trim(r.source_quote)) = 0);" 2>/dev/null
fi

echo ""
echo "=== 5. Denial-scorer attribute coverage ==========================="
sudo -u postgres psql -X -q -d "$PG_DB" -c \
  "SELECT attribute, count(*) AS live_rules, count(DISTINCT payer_id) AS payers
     FROM payer_rule WHERE expiration_date IS NULL
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
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILURES:%b\n' "$FAILURES"
  echo ""
  echo "Do not tell the client this is done. Send the output above."
  exit 1
fi
echo "Production matches what was verified locally."
exit 0
