#!/usr/bin/env bash
# =============================================================================
#  replay-from-scratch.sh — rebuild the entire rule library in a throwaway
#  database, from migration 0001 forward, and prove the result is the one
#  production is serving.
#
#  WHY THIS EXISTS
#  ---------------
#  Production is built incrementally: a deploy applies whatever migrations
#  and seeds are new since the last one. Nobody ever runs the whole sequence
#  end to end, so an ordering bug can sit in the repo indefinitely and only
#  surface on the one deploy where the wrong subset happens to run.
#
#  That is not hypothetical. Editing payer-rules-denial-attributes.sql made
#  it re-run ALONE. Its supersession expired round 2's rules on 28 shared
#  keys, and its own ON CONFLICT ... expiration_date = NULL revived its
#  rows. Production then served the OLDER rule on those keys. Every row
#  count was correct. Nothing errored. It was found by reading the answer
#  TEXT, days later.
#
#  deploy.sh now cascades — any pending seed forces every later seed to
#  re-run — which fixes that class going forward. This script is the proof
#  that the cascade produces the right library, and the standing check that
#  it still does after the next seed is added.
#
#  WHAT IT ASSERTS
#  ---------------
#    1. Every migration applies to an empty database, in filename order.
#    2. Every seed in db/seed/MANIFEST applies, in manifest order.
#    3. The two maintenance scripts run clean at the end.
#    4. The LIMIT 1 invariant holds at six dates of service, not just today.
#    5. The rebuilt library matches the reference database rule for rule --
#       same keys, same answers. A key that differs is printed.
#
#  Step 5 is the one that catches ordering bugs. Steps 1-4 pass even when
#  the wrong rule wins, because the wrong rule is still exactly one rule.
#
#  TWO MODES
#  ---------
#    MODE=scratch   (default) build from an empty database: migrations,
#                   then seeds, then maintenance. Proves the repo alone
#                   reproduces the library. Needs every extension the
#                   migrations require -- so, in practice, the VPS.
#
#    MODE=cascade   copy the reference database and re-apply every seed
#                   onto it, in manifest order, exactly as deploy.sh's
#                   cascade does. Proves that re-running the seeds over an
#                   already-populated database does not MOVE an answer.
#                   This is the direct regression test for the incident
#                   above, and it runs anywhere, including a dev box
#                   without pgvector, because it never builds the schema.
#
#  Run cascade on every seed change. Run scratch before a release.
#
#  USAGE
#  -----
#    PG_DB=billing_rules PSQL_BIN="psql -h localhost -U postgres" \
#      bash scripts/replay-from-scratch.sh
#
#    MODE=cascade PG_DB=billing_rules PSQL_BIN="psql -h localhost -U postgres" \
#      bash scripts/replay-from-scratch.sh
#
#  PG_DB is the REFERENCE database to compare against -- it is opened
#  read-only and never written. The replay happens in PG_DB_REPLAY
#  (default: <PG_DB>_replay), which is DROPPED and recreated on every run.
#
#    KEEP_REPLAY_DB=1   leave the scratch database behind for inspection
#
#  EXIT CODES
#  ----------
#    0   the replay reproduced the reference library exactly
#    1   it did not, or a migration/seed/maintenance script failed
#    2   bad invocation, or the reference database is unreachable
# =============================================================================

set -uo pipefail

PG_DB="${PG_DB:-pallio}"
PSQL_BIN="${PSQL_BIN:-sudo -u postgres psql}"
PG_DB_REPLAY="${PG_DB_REPLAY:-${PG_DB}_replay}"
MODE="${MODE:-scratch}"
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

case "$MODE" in
  scratch|cascade) ;;
  *) echo "FATAL: MODE must be 'scratch' or 'cascade', got '$MODE'"; exit 2 ;;
esac

case "$PSQL_BIN" in
  sudo*) [ "$(id -u)" = "0" ] || { echo "FATAL: run with sudo (needs the postgres role)"; exit 2; } ;;
esac

# Refuse to replay into the database being compared against. The replay
# starts by DROPPING its target.
if [ "$PG_DB_REPLAY" = "$PG_DB" ]; then
  echo "FATAL: PG_DB_REPLAY must differ from PG_DB -- the replay drops its target"
  exit 2
fi

REF()  { $PSQL_BIN -X -tAq -d "$PG_DB"        -c "$1"; }
RPL()  { $PSQL_BIN -X -tAq -d "$PG_DB_REPLAY" -c "$1"; }
ADMIN() { $PSQL_BIN -X -tAq -d postgres       -c "$1"; }

REF "SELECT 1" >/dev/null 2>&1 \
  || { echo "FATAL: cannot reach reference database '$PG_DB' with: $PSQL_BIN"; exit 2; }

[ -f db/seed/MANIFEST ] || { echo "FATAL: run from the repo root (db/seed/MANIFEST not found)"; exit 2; }

FAILED=0
note() { printf '  %s\n' "$1"; }
fail() { printf '\n  FAIL: %s\n' "$1"; FAILED=$((FAILED + 1)); }

echo "==========================================================================="
if [ "$MODE" = "cascade" ]; then
  echo " SEED CASCADE REPLAY"
  echo "   copy $PG_DB, re-apply every seed onto it, check no answer moved"
else
  echo " REPLAY FROM SCRATCH"
  echo "   reference: $PG_DB      replay into: $PG_DB_REPLAY (dropped and rebuilt)"
fi
echo "==========================================================================="

if [ "$MODE" = "cascade" ]; then
  # Copy the reference and skip straight to the seeds. CREATE DATABASE ...
  # TEMPLATE needs no other session connected to the source, which is why
  # this is a maintenance-window check on the VPS but free on a dev box.
  echo
  echo "[1/6] copying $PG_DB -> $PG_DB_REPLAY"
  ADMIN "DROP DATABASE IF EXISTS \"$PG_DB_REPLAY\"" >/dev/null 2>&1
  if ! out="$(ADMIN "CREATE DATABASE \"$PG_DB_REPLAY\" TEMPLATE \"$PG_DB\"" 2>&1)"; then
    echo "FATAL: could not copy $PG_DB. Other sessions must disconnect first."
    printf '%s\n' "$out" | tail -3 | sed 's/^/        /'
    exit 2
  fi
  note "copied"
  echo
  echo "[2/6] migrations — skipped (MODE=cascade starts from the built schema)"
  N_MIG=0
else

# --- 0. can this server even host the schema? -------------------------------
#
# The migrations CREATE EXTENSION for everything they need, so a server
# missing one fails at migration 0001. That is a fact about the SERVER, not
# about the repo, and reporting it as "the repo does not reproduce
# production" would be a false alarm of the exact kind this script exists to
# prevent. Checked first, and reported as a bad environment (exit 2).
#
# The required list is read out of the migrations rather than hardcoded, so
# an extension added in a future migration is covered without editing this.
echo
echo "[0/6] checking this server can host the schema"
REQUIRED_EXT="$(grep -rhoiE 'CREATE EXTENSION IF NOT EXISTS "?[a-z_-]+"?' db/migrations/*.sql \
  | sed -E 's/.*NOT EXISTS "?//; s/"?$//' | tr 'A-Z' 'a-z' | sort -u)"
MISSING_EXT=""
for ext in $REQUIRED_EXT; do
  ok="$(ADMIN "SELECT count(*) FROM pg_available_extensions WHERE name = '$ext'" | tr -d '[:space:]')"
  [ "$ok" = "1" ] || MISSING_EXT="$MISSING_EXT $ext"
done
if [ -n "$MISSING_EXT" ]; then
  echo
  echo "  CANNOT REPLAY ON THIS SERVER — extension(s) not available:$MISSING_EXT"
  echo
  echo "  The migrations require them, so the schema cannot be built here."
  echo "  This says nothing about whether the repo reproduces production."
  echo "  Run this on the VPS, where the extensions are installed:"
  echo
  echo "    cd /opt/pallio/app && sudo bash scripts/replay-from-scratch.sh"
  echo
  exit 2
fi
note "all required extensions available:$(printf ' %s' $REQUIRED_EXT)"

# --- 1. empty database ------------------------------------------------------
echo
echo "[1/6] creating an empty database"
ADMIN "DROP DATABASE IF EXISTS \"$PG_DB_REPLAY\"" >/dev/null 2>&1
ADMIN "CREATE DATABASE \"$PG_DB_REPLAY\"" >/dev/null \
  || { echo "FATAL: could not create $PG_DB_REPLAY"; exit 2; }
note "created"

# --- 2. every migration, in order -------------------------------------------
echo
echo "[2/6] applying every migration in filename order"
N_MIG=0
for f in $(ls db/migrations/*.sql | sort); do
  if ! out="$($PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_REPLAY" -f "$f" 2>&1)"; then
    fail "migration $(basename "$f") did not apply to an empty database"
    printf '%s\n' "$out" | tail -6 | sed 's/^/        /'
    echo
    echo "  A migration that cannot run from scratch means this database cannot"
    echo "  be rebuilt from the repo. Stopping here — everything after it is"
    echo "  meaningless."
    exit 1
  fi
  N_MIG=$((N_MIG + 1))
done
note "$N_MIG migrations applied"

fi  # end MODE=scratch

# --- 3. every seed, in MANIFEST order ---------------------------------------
echo
echo "[3/6] applying every seed in db/seed/MANIFEST order"
N_SEED=0
while IFS= read -r base; do
  case "$base" in ''|\#*) continue ;; esac
  base="$(printf '%s' "$base" | tr -d '\r' | sed 's/[[:space:]]*$//')"
  [ -z "$base" ] && continue
  if [ ! -f "db/seed/$base" ]; then
    fail "MANIFEST names db/seed/$base, which does not exist"
    continue
  fi
  if ! out="$($PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_REPLAY" -f "db/seed/$base" 2>&1)"; then
    fail "seed $base did not apply"
    printf '%s\n' "$out" | tail -6 | sed 's/^/        /'
    exit 1
  fi
  N_SEED=$((N_SEED + 1))
done < db/seed/MANIFEST
note "$N_SEED seeds applied"

# --- 4. the maintenance scripts deploy.sh runs after the seeds --------------
echo
echo "[4/6] running the post-seed maintenance scripts"
# Same order deploy.sh step 6 runs them in. The scorer backfill is after the
# timeline repair because it resolves "live" the way fetchPayerRule does.
MAINT="db/maintenance/close-rule-timelines.sql
db/maintenance/backfill-structured-scorer-fields.sql
db/maintenance/retire-uncited-document-versions.sql"

# A hand-kept list in two scripts is the drift this repo keeps getting bitten
# by, so an unlisted maintenance script is an error rather than a silent skip.
for f in db/maintenance/*.sql; do
  case "$MAINT" in
    *"$f"*) ;;
    *) fail "db/maintenance/$(basename "$f") is not in this script's run list — add it here and to deploy.sh step 6" ;;
  esac
done

for m in $MAINT; do
  [ -f "$m" ] || { note "$(basename "$m") — not present, skipped"; continue; }
  if out="$($PSQL_BIN -X -q -v ON_ERROR_STOP=1 -d "$PG_DB_REPLAY" -f "$m" 2>&1)"; then
    note "$(basename "$m") — ok"
    printf '%s\n' "$out" | grep -E '^NOTICE' | sed 's/^NOTICE:  /        /'
  else
    fail "$(basename "$m") failed on a freshly built database"
    printf '%s\n' "$out" | tail -6 | sed 's/^/        /'
  fi
done

# --- 5. the LIMIT 1 invariant, at six dates of service ----------------------
#
# fetchPayerRule ends in ORDER BY ... LIMIT 1 with no confidence tiebreak,
# so two rows live on one key make the answer depend on row order. Checked
# at PAST dates too: a denial is re-worked at the date on the CLAIM, inside
# a 90-365 day timely-filing window, and the deploy that left 28 keys
# ambiguous at 90 days back was clean at 0.
echo
echo "[5/6] LIMIT 1 invariant, at six dates of service"
for d in 0 30 90 180 365 730; do
  n="$(RPL "
    SELECT count(*) FROM (
      SELECT payer_id, state, code, attribute, product_line
        FROM payer_rule
       WHERE effective_date <= CURRENT_DATE - $d
         AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE - $d)
       GROUP BY 1,2,3,4,5 HAVING count(*) > 1) x" | tr -d '[:space:]')"
  if [ "$n" = "0" ]; then
    note "DOS -${d}d: 0 ambiguous keys"
  else
    fail "DOS -${d}d: $n key(s) served by more than one rule"
    RPL "
      SELECT payer_id::text, state, code, attribute, count(*)
        FROM payer_rule
       WHERE effective_date <= CURRENT_DATE - $d
         AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE - $d)
       GROUP BY 1,2,3,4 HAVING count(*) > 1 LIMIT 10" | sed 's/^/        /'
  fi
done

# --- 6. does the replay ANSWER the same as the reference? -------------------
#
# The check the row counts cannot do. Two libraries can have identical
# counts and disagree on which rule wins -- that is exactly what the seed
# cascade bug looked like. So compare the ANSWER on every key: same key
# set, and the same value + source on each shared key.
echo
echo "[6/6] comparing answers against the reference database"

# value is jsonb, so it is rendered with ::text, not concatenated raw --
# `coalesce(value,'')` is a type error, and a type error here returns ZERO
# rows on BOTH sides, which compares equal and reports a clean pass. This
# script exists to catch silent equality; it does not get to produce it.
# Hence the emptiness guard below.
ANSWERS="SELECT payer_id::text || '|' || coalesce(state,'') || '|' || code || '|' || attribute
              || '|' || coalesce(product_line,'') || ' => ' || coalesce(value::text,'null')
         FROM payer_rule
        WHERE effective_date <= CURRENT_DATE
          AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
        ORDER BY 1"

TMP_REF="$(mktemp)"; TMP_RPL="$(mktemp)"
trap 'rm -f "$TMP_REF" "$TMP_RPL"' EXIT

REF "$ANSWERS" > "$TMP_REF" 2>"$TMP_REF.err"
RPL "$ANSWERS" > "$TMP_RPL" 2>"$TMP_RPL.err"

n_ref="$(wc -l < "$TMP_REF" | tr -d '[:space:]')"
n_rpl="$(wc -l < "$TMP_RPL" | tr -d '[:space:]')"
note "reference: $n_ref live answers    replay: $n_rpl live answers"

# Two empty sets compare equal. A comparison over nothing is not evidence
# of anything, so it fails loudly instead of passing quietly.
if [ "$n_ref" = "0" ] || [ "$n_rpl" = "0" ]; then
  fail "the comparison query returned no rows — nothing was actually compared"
  for e in "$TMP_REF.err" "$TMP_RPL.err"; do
    [ -s "$e" ] && sed 's/^/        /' "$e" | head -4
  done
  rm -f "$TMP_REF.err" "$TMP_RPL.err"
  echo
  echo "        A library with zero live rules answers no question at all."
  echo "==========================================================================="
  exit 1
fi
rm -f "$TMP_REF.err" "$TMP_RPL.err"

if diff -q "$TMP_REF" "$TMP_RPL" >/dev/null 2>&1; then
  note "identical — every key answers the same in both"
else
  # Split the difference into the three kinds that mean different things.
  only_ref="$(comm -23 "$TMP_REF" "$TMP_RPL" | wc -l | tr -d '[:space:]')"
  only_rpl="$(comm -13 "$TMP_REF" "$TMP_RPL" | wc -l | tr -d '[:space:]')"
  fail "the rebuilt library does not match the reference"
  echo "        in reference but not replay: $only_ref"
  echo "        in replay but not reference: $only_rpl"
  echo
  echo "        A key present in BOTH lists with a different value after '=>'"
  echo "        is the dangerous case: the same key answering differently."
  echo
  comm -23 "$TMP_REF" "$TMP_RPL" | head -15 | sed 's/^/        REF-only  /'
  comm -13 "$TMP_REF" "$TMP_RPL" | head -15 | sed 's/^/        RPL-only  /'
fi

# --- teardown ---------------------------------------------------------------
if [ "${KEEP_REPLAY_DB:-0}" = "1" ]; then
  echo
  note "KEEP_REPLAY_DB=1 — leaving $PG_DB_REPLAY in place"
else
  ADMIN "DROP DATABASE IF EXISTS \"$PG_DB_REPLAY\"" >/dev/null 2>&1
fi

echo
echo "==========================================================================="
if [ "$FAILED" = "0" ]; then
  if [ "$MODE" = "cascade" ]; then
    echo " CASCADE OK — re-applying all $N_SEED seeds moved no answer."
    echo " A deploy that re-runs the seeds serves what it serves today."
  else
    echo " REPLAY OK — $N_MIG migrations + $N_SEED seeds rebuild the library exactly."
    echo " The repo alone is enough to reproduce what production serves."
  fi
  echo "==========================================================================="
  exit 0
fi
if [ "$MODE" = "cascade" ]; then
  echo " CASCADE FAILED — $FAILED problem(s) above."
  echo " Re-applying the seeds CHANGES an answer. A deploy would move it."
else
  echo " REPLAY FAILED — $FAILED problem(s) above."
  echo " The repo does NOT currently reproduce the reference database."
fi
echo "==========================================================================="
exit 1
