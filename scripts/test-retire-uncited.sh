#!/usr/bin/env bash
# =============================================================================
#  test-retire-uncited.sh — regression test for
#  db/maintenance/retire-uncited-document-versions.sql
#
#  That script DELETES rows from source_document on every deploy. It ran
#  untested for exactly one production preview before the preview caught it
#  doing nothing at all: document_chunk was counted as a reference that
#  protects a version, but chunking runs on whatever the crawler just
#  fetched, so every churned version protected itself. All 13 versions of
#  the Aetna policy page were "cited", 0 were retired, and the script
#  reported success. This test is what stops that recurring.
#
#  SAFETY
#  ------
#  Everything happens in a THROWAWAY COPY of the target database
#  (<PG_DB>_rettest), created with CREATE DATABASE ... TEMPLATE and dropped
#  at the end. The database named by PG_DB is opened only to be copied and
#  is never written.
#
#  USAGE
#  -----
#    PG_DB=billing_rules PSQL_BIN="psql -h localhost -U postgres" \
#      bash scripts/test-retire-uncited.sh
#
#    KEEP_TEST_DB=1   leave the copy behind for inspection
#
#  CREATE DATABASE ... TEMPLATE needs no other session connected to PG_DB,
#  so on the VPS this is a maintenance-window check, not a live one.
#
#  EXIT CODES
#  ----------
#    0   every case behaved as specified
#    N   N cases did not
#    2   could not set up (database unreachable, copy refused)
# =============================================================================

set -uo pipefail

PG_DB="${PG_DB:-pallio}"
PSQL_BIN="${PSQL_BIN:-sudo -u postgres psql}"
PG_DB_TEST="${PG_DB_TEST:-${PG_DB}_rettest}"
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

case "$PSQL_BIN" in
  sudo*) [ "$(id -u)" = "0" ] || { echo "FATAL: run with sudo (needs the postgres role)"; exit 2; } ;;
esac
[ "$PG_DB_TEST" = "$PG_DB" ] && { echo "FATAL: PG_DB_TEST must differ from PG_DB — it gets dropped"; exit 2; }

FIXTURE="db/maintenance/__tests__/retire-uncited-fixture.sql"
SCRIPT="db/maintenance/retire-uncited-document-versions.sql"
[ -f "$FIXTURE" ] && [ -f "$SCRIPT" ] || { echo "FATAL: run from the repo root"; exit 2; }

T()     { $PSQL_BIN -X -tAq -d "$PG_DB_TEST" -c "$1"; }
ADMIN() { $PSQL_BIN -X -tAq -d postgres      -c "$1"; }

FAILED=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  PASS  %-58s %s\n' "$1" "$3"
  else
    printf '  FAIL  %-58s expected %s, got %s\n' "$1" "$2" "$3"
    FAILED=$((FAILED + 1))
  fi
}

$PSQL_BIN -X -tAq -d "$PG_DB" -c "SELECT 1" >/dev/null 2>&1 \
  || { echo "FATAL: cannot reach '$PG_DB' with: $PSQL_BIN"; exit 2; }

echo "==========================================================================="
echo " retire-uncited-document-versions.sql — regression test"
echo "   throwaway copy: $PG_DB_TEST"
echo "==========================================================================="

ADMIN "DROP DATABASE IF EXISTS \"$PG_DB_TEST\"" >/dev/null 2>&1
if ! out="$(ADMIN "CREATE DATABASE \"$PG_DB_TEST\" TEMPLATE \"$PG_DB\"" 2>&1)"; then
  echo "FATAL: could not copy $PG_DB — other sessions must disconnect first."
  printf '%s\n' "$out" | tail -3 | sed 's/^/        /'
  exit 2
fi

cleanup() {
  [ "${KEEP_TEST_DB:-0}" = "1" ] && { echo; echo "  KEEP_TEST_DB=1 — left $PG_DB_TEST in place"; return; }
  ADMIN "DROP DATABASE IF EXISTS \"$PG_DB_TEST\"" >/dev/null 2>&1
}
trap cleanup EXIT

$PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_TEST" -f "$FIXTURE" >/dev/null \
  || { echo "FATAL: fixture failed to load"; exit 2; }

REAL_BEFORE="$(T "SELECT count(*) FROM source_document WHERE id::text NOT LIKE 'dd000000%'")"

echo
echo "--- run 1: the retirement -------------------------------------------------"
RUN1="$($PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_TEST" -f "$SCRIPT" 2>&1)"
# psql prefixes every notice with "psql:<file>:<line>: ", so anchoring on
# ^NOTICE matches nothing — which is how the idempotence check below came
# out empty and still reported a result the first time this test ran.
printf '%s\n' "$RUN1" | grep -E 'NOTICE:' | sed 's/.*NOTICE:  /  /'
if printf '%s\n' "$RUN1" | grep -q 'ERROR:'; then
  printf '%s\n' "$RUN1" | grep 'ERROR:' | sed 's/^/  /'
  FAILED=$((FAILED + 1))
fi

# Survivor counts per case. The URL's 4th path element names the case.
surv() { T "SELECT count(*) FROM source_document WHERE url LIKE 'https://fixture.test/$1%'"; }

echo
echo "--- what survived ---------------------------------------------------------"

# A. Production's Aetna shape: 13 versions, v1..v12 hold identical chunks and
#    nothing else, the OLDEST holds no chunks and all 6 rule citations.
#    Keep the newest (has the text) and the oldest (has the citations).
check "A aetna: versions kept"                        2 "$(surv aetna)"
check "A aetna: the newest kept"                      1 "$(T "SELECT count(*) FROM source_document WHERE title = 'fixture A v1'")"
check "A aetna: the CITED oldest kept"                1 "$(T "SELECT count(*) FROM source_document WHERE title = 'fixture A v13'")"
check "A aetna: chunks left (one copy, not twelve)"   5 "$(T "SELECT count(*) FROM document_chunk c JOIN source_document s ON s.id=c.source_doc_id WHERE s.url LIKE '%/aetna/%'")"
check "A aetna: all 6 rule citations still resolve"   6 "$(T "SELECT count(*) FROM payer_rule r JOIN source_document s ON s.id=r.source_doc_id WHERE s.title='fixture A v13'")"

# B. Production's Federal Register shape: no chunks anywhere, the three
#    oldest carry the rules.
check "B federal register: versions kept"             4 "$(surv fr)"
check "B federal register: all 6 citations resolve"   6 "$(T "SELECT count(*) FROM payer_rule r JOIN source_document s ON s.id=r.source_doc_id WHERE s.url LIKE '%/fr/%'")"

# C. The only chunks live on an UNCITED middle version. Deleting it would
#    drop the document out of retrieval, so it is rescued.
check "C rescue: nothing retired"                     3 "$(surv rescue-chunks)"
check "C rescue: the text survived"                   4 "$(T "SELECT count(*) FROM document_chunk c JOIN source_document s ON s.id=c.source_doc_id WHERE s.url LIKE '%rescue-chunks%'")"

# D. The kept set HAS chunks, but none embedded — present is not the same as
#    retrievable, so the embedded copy is rescued too.
check "D rescue on embeddings: nothing retired"       3 "$(surv rescue-embedded)"
check "D rescue on embeddings: embedded copy kept"    3 "$(T "SELECT count(*) FROM document_chunk c JOIN source_document s ON s.id=c.source_doc_id WHERE s.url LIKE '%rescue-embedded%' AND c.embedding IS NOT NULL")"

# E/F. Nothing to do must mean nothing done.
check "E single version: untouched"                   1 "$(surv single)"
check "F every version cited: untouched"              3 "$(surv all-cited)"

# G. No chunks anywhere, so the rescue must NOT fire and block the delete.
check "G dead middle: only the newest kept"           1 "$(surv dead-middle)"

echo
echo "--- invariants ------------------------------------------------------------"
check "real (non-fixture) documents untouched"        "$REAL_BEFORE" "$(T "SELECT count(*) FROM source_document WHERE id::text NOT LIKE 'dd000000%'")"
check "no payer_rule cites a deleted document"        0 "$(T "SELECT count(*) FROM payer_rule r WHERE r.source_doc_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id=r.source_doc_id)")"
check "every retired row is journaled"                18 "$(T "SELECT count(*) FROM document_version_retirement_journal WHERE document_id::text LIKE 'dd000000%'")"

echo
echo "--- run 2: idempotence ----------------------------------------------------"
RUN2="$($PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_TEST" -f "$SCRIPT" 2>&1)"
printf '%s\n' "$RUN2" | grep -E 'NOTICE.*retired' | sed 's/.*NOTICE:  /  /'
check "second run retires nothing" 0 \
  "$(printf '%s\n' "$RUN2" | sed -n 's/.*document versions: \([0-9]*\) .*/\1/p')"

# The guard has to be able to REFUSE, or it is a comment rather than a check.
# Gut the rescue and confirm the postcondition stops the whole transaction.
echo
echo "--- negative test: break the rescue, the guard must refuse ----------------"
$PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_TEST" -f "$FIXTURE" >/dev/null 2>&1
BEFORE_NEG="$(T "SELECT count(*) FROM source_document WHERE id::text LIKE 'dd000000%'")"
NORESCUE="$(mktemp -t norescue.XXXXXX.sql)"
awk 'BEGIN{done=0}
     done==0 && /^ WHERE v\.recency > 1 AND v\.refs = 0$/ { print " WHERE false AND v.recency > 1 AND v.refs = 0"; done=1; next }
     { print }' "$SCRIPT" > "$NORESCUE"
if cmp -s "$SCRIPT" "$NORESCUE"; then
  echo "  FAIL  could not disable the rescue — this test proved nothing"
  FAILED=$((FAILED + 1))
else
  NEG="$($PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_TEST" -f "$NORESCUE" 2>&1)"
  if printf '%s\n' "$NEG" | grep -q 'would lose all retrievable text'; then
    printf '  PASS  %-58s %s\n' "guard refused" "$(printf '%s\n' "$NEG" | sed -n 's/.*ERROR:  //p' | head -1)"
  else
    printf '  FAIL  %-58s\n' "guard did NOT refuse — documents can silently lose their text"
    FAILED=$((FAILED + 1))
  fi
  check "and the whole transaction rolled back" "$BEFORE_NEG" \
    "$(T "SELECT count(*) FROM source_document WHERE id::text LIKE 'dd000000%'")"
fi
rm -f "$NORESCUE"

echo
echo "==========================================================================="
if [ "$FAILED" = "0" ]; then
  echo " ALL CASES PASSED"
  echo "==========================================================================="
  exit 0
fi
echo " $FAILED CASE(S) FAILED"
echo "==========================================================================="
exit "$FAILED"
