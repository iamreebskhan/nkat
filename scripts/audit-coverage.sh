#!/usr/bin/env bash
# audit-coverage.sh — LAYER 1: the payer-rule coverage matrix.
#
# Run on the VPS:
#   sudo bash /opt/pallio/app/scripts/audit-coverage.sh
#   sudo bash /opt/pallio/app/scripts/audit-coverage.sh > /tmp/coverage.txt 2>&1
#
# ---------------------------------------------------------------------------
# WHAT THIS PROVES
#
#   verify-production.sh counts rows and spot-checks a few of them. It can pass
#   with a payer that has 400 rules and still cannot answer "does this payer
#   need prior auth on 99349". This script answers the different question:
#   FOR EVERY PAYER, EVERY IN-SCOPE CODE, EVERY ATTRIBUTE — is there a live
#   rule sitting in that cell, yes or no?
#
#   It prints, from the production database:
#     1. every lookup lane the platform serves (payer x state — that is the
#        real key, because a Medicare rule filed under NC does not answer an
#        Ohio question)
#     2. a payer-by-attribute matrix: how many of the 25 in-scope codes have a
#        live rule in each cell
#     3. how ready each lane is for the denial scorer specifically
#     4. the NAME of every empty cell for the four attributes the denial
#        scorer reads — payer, state, code, attribute
#     5. payers carrying no in-scope rules at all
#     6. payers covering fewer than half the in-scope codes
#     7. rules that exist but the denial scorer structurally cannot see
#     8. rules that exist but carry no prose answer
#
# WHAT THIS DELIBERATELY DOES NOT DO
#
#   * It does NOT judge whether an answer is CORRECT. A cell with a rule is
#     counted as filled even if the rule is wrong. Correctness against source
#     documents is a different audit.
#   * It does NOT call lookupRule() and therefore never touches the Anthropic
#     API. lookupRule() falls through to RAG + Claude synthesis when no
#     structured rule exists; exercising the empty cells live would fire
#     thousands of paid calls. This reads the table directly instead.
#   * It does NOT treat an empty cell as a bug. A payer that publishes nothing
#     about 99427 cannot be covered on 99427. Sections 2-7 are a REPORT: the
#     point is that the gaps are visible and countable here rather than
#     discovered by a practice on a denied claim.
#   * It does NOT cover 99343 (retired) or any code outside home-based
#     palliative care. Section 10 notes 99343 rows if any are still live.
#   * It does NOT write anything. Every statement is a SELECT. No INSERT,
#     UPDATE, DELETE, ALTER, CREATE — not even a temp table.
#   * It does NOT use npx or tsx. psql only.
#
# EXIT CODE
#
#   Section 9 is the only pass/fail part, and it is the only thing that moves
#   the exit code. Those five guards are not about publishing gaps — they are
#   invariants that, if broken, mean the library returns the WRONG answer
#   rather than no answer. Exit 0 = all five hold. Exit 1 = at least one
#   broke, and it is repeated at the bottom.
# ---------------------------------------------------------------------------

set -uo pipefail

PG_DB="${PG_DB:-pallio}"
PSQL_BIN="${PSQL_BIN:-sudo -u postgres psql}"

case "$PSQL_BIN" in
  sudo*) [ "$(id -u)" = "0" ] || { echo "FATAL: run with sudo (needs the postgres role)"; exit 2; } ;;
esac

# Q  — run SQL, print the rows raw (we format inside SQL, not with psql borders)
# Q1 — run SQL, return one scalar with whitespace stripped
Q()  { $PSQL_BIN -X -tAq -d "$PG_DB" -c "$1"; }
Q1() { $PSQL_BIN -X -tAq -d "$PG_DB" -c "$1" 2>/dev/null | tr -d '[:space:]'; }

$PSQL_BIN -X -tAq -d "$PG_DB" -c "SELECT 1" >/dev/null 2>&1 \
  || { echo "FATAL: cannot reach database '$PG_DB' with: $PSQL_BIN"; exit 2; }

# ---------------------------------------------------------------------------
# Shared SQL prelude. Every query below starts with this, then either goes
# straight to SELECT or adds more CTEs with a leading comma.
#
#   scope — the 25 in-scope home-based palliative care codes (99343 excluded,
#           it is retired)
#   attrs — the 10 attributes, in report order, with the 4 the denial scorer
#           reads flagged. NOTE: the scorer's "coverage_status" is carried on
#           the attribute='covered' row, so 'covered' is what we test for.
#   lane  — payer x state. This is fetchPayerRule's real key, so it is the
#           unit of coverage. Only active payers.
#   live  — live in-scope rules. Live means expiration_date IS NULL.
# ---------------------------------------------------------------------------
PRELUDE="
WITH scope(code) AS (VALUES
  ('99341'),('99342'),('99344'),('99345'),('99347'),('99348'),('99349'),('99350'),
  ('99497'),('99498'),
  ('99417'),('G0318'),
  ('G0179'),('G0180'),('G0181'),
  ('99495'),('99496'),
  ('99490'),('99439'),('99491'),('99424'),('99425'),('99426'),('99427'),
  ('99499')),
attrs(attribute, hdr, ord, scorer) AS (VALUES
  ('covered',                   'COV',  1, true),
  ('prior_auth_required',       'PA',   2, true),
  ('modifier_required',         'MOD',  3, true),
  ('frequency_limit',           'FRQ',  4, true),
  ('telehealth_allowed',        'TEL',  5, false),
  ('pos_allowed',               'POS',  6, false),
  ('provider_taxonomy_allowed', 'TAX',  7, false),
  ('documentation_required',    'DOC',  8, false),
  ('units_per_period_max',      'UNI',  9, false),
  ('bundled_with',              'BND', 10, false)),
lane AS (
  SELECT p.id, p.name::text AS name, s.state
    FROM payer p
    CROSS JOIN LATERAL unnest(p.states_served) AS s(state)
   WHERE p.active),
live AS (
  SELECT r.payer_id, r.state, r.code, r.attribute
    FROM payer_rule r
    JOIN scope sc ON sc.code = r.code
   WHERE r.expiration_date IS NULL)
"

# Every lane label in every section is rendered the same width so the
# sections stack visually: 2 spaces + 41-char "PAYER /ST" field.
RULE_LINE="$(printf '%0.s-' $(seq 1 89))"

PASS=0
FAIL=0
FAILURES=""

check() {
  local label="$1" want="$2" got="$3"
  if [ "${got:-x}" = "$want" ]; then
    printf '  PASS  %-62s %s\n' "$label" "$got"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %-62s got=%s want=%s\n' "$label" "${got:-<none>}" "$want"
    FAIL=$((FAIL + 1))
    FAILURES="$FAILURES\n  - $label (got ${got:-<none>}, want $want)"
  fi
}

echo ""
echo "==========================================================================="
echo " PALLIO RULE-LIBRARY COVERAGE AUDIT"
echo " database: $PG_DB    generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "==========================================================================="

# ===========================================================================
echo ""
echo "=== 0. What is in scope ==================================================="
echo ""
Q "$PRELUDE
SELECT '  codes in scope      : ' || count(*)::text FROM scope
UNION ALL SELECT '  attributes in scope : ' || count(*)::text FROM attrs
UNION ALL SELECT '  active payers       : ' || count(DISTINCT id)::text FROM lane
UNION ALL SELECT '  lookup lanes        : ' || count(*)::text || ' (payer x state)' FROM lane
UNION ALL SELECT '  cells to account for: ' ||
       ((SELECT count(*) FROM lane) * (SELECT count(*) FROM scope) * (SELECT count(*) FROM attrs))::text
UNION ALL SELECT '  live rules in scope : ' || count(*)::text FROM live;"
echo ""
echo "  in-scope codes:"
Q "$PRELUDE
SELECT '    ' || string_agg(code, ' ' ORDER BY code) FROM scope;"
echo "    (99343 excluded - retired)"

# ===========================================================================
echo ""
echo "=== 1. The lookup lanes ==================================================="
echo ""
echo "  A rule is found by (payer, state, code, attribute). A payer serving"
echo "  three states is three lanes, and a rule filed in one does not answer"
echo "  the others. Coverage below is measured per lane."
echo ""
printf '  %-41s%s\n' "LANE" "  IN-SCOPE CODES WITH ANY LIVE RULE"
Q "$PRELUDE
SELECT '  ' || rpad(left(lane.name, 36) || ' /' || lane.state, 41)
    || lpad(count(DISTINCT l.code)::text, 4) || ' of 25'
  FROM lane LEFT JOIN live l ON l.payer_id = lane.id AND l.state = lane.state
 GROUP BY lane.name, lane.state
 ORDER BY count(DISTINCT l.code) DESC, lane.name, lane.state;"

# ===========================================================================
echo ""
echo "=== 2. THE COVERAGE MATRIX ================================================"
echo ""
echo "  Each cell = how many of the 25 in-scope codes have a live rule for that"
echo "  attribute in that lane. '.' means zero. TOTAL is out of 250 cells."
echo ""
Q "$PRELUDE
SELECT '  ' || rpad('PAYER / STATE', 41)
    || string_agg(lpad(hdr, 4), '' ORDER BY ord)
    || lpad('TOTAL', 8)
  FROM attrs;"
echo "  $RULE_LINE"
Q "$PRELUDE
, grid AS (
  SELECT lane.name, lane.state, a.ord, count(DISTINCT l.code) AS n
    FROM lane
    CROSS JOIN attrs a
    LEFT JOIN live l
      ON l.payer_id = lane.id AND l.state = lane.state AND l.attribute = a.attribute
   GROUP BY lane.name, lane.state, a.ord)
SELECT '  ' || rpad(left(name, 36) || ' /' || state, 41)
    || string_agg(lpad(CASE WHEN n = 0 THEN '.' ELSE n::text END, 4), '' ORDER BY ord)
    || lpad(sum(n)::text, 8)
  FROM grid
 GROUP BY name, state
 ORDER BY sum(n) DESC, name, state;"
echo "  $RULE_LINE"
Q "$PRELUDE
, grid AS (
  SELECT a.ord, count(DISTINCT (lane.id::text || lane.state || l.code)) AS n
    FROM lane
    CROSS JOIN attrs a
    LEFT JOIN live l
      ON l.payer_id = lane.id AND l.state = lane.state AND l.attribute = a.attribute
   GROUP BY a.ord)
SELECT '  ' || rpad('ALL LANES (filled cells per attribute)', 41)
    || string_agg(lpad(CASE WHEN n = 0 THEN '.' ELSE n::text END, 4), '' ORDER BY ord)
    || lpad(sum(n)::text, 8)
  FROM grid;"
echo ""
echo "  legend:"
Q "$PRELUDE
SELECT '    ' || rpad(hdr, 5) || '= '
    || CASE WHEN scorer THEN rpad(attribute, 27) || '<- denial scorer reads this'
            ELSE attribute END
  FROM attrs ORDER BY ord;"

# ===========================================================================
echo ""
echo "=== 3. Denial-scorer readiness ============================================"
echo ""
echo "  The denial scorer reads four things per code: coverage_status (carried"
echo "  on the 'covered' rule), prior_auth_required, modifier_required and"
echo "  frequency_limit. 25 codes x 4 = 100 cells per lane. A code is FULLY"
echo "  ANSWERABLE only when all four are present."
echo ""
printf '  %-41s%8s%8s%11s\n' "LANE" "FILLED" "OF" "ANSWERABLE"
Q "$PRELUDE
, cells AS (
  SELECT lane.name, lane.state, sc.code,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM live l
            WHERE l.payer_id = lane.id AND l.state = lane.state
              AND l.code = sc.code AND l.attribute = a.attribute)) AS filled
    FROM lane CROSS JOIN scope sc CROSS JOIN attrs a
   WHERE a.scorer
   GROUP BY lane.name, lane.state, sc.code)
SELECT '  ' || rpad(left(name, 36) || ' /' || state, 41)
    || lpad(sum(filled)::text, 8) || lpad('100', 8)
    || lpad(count(*) FILTER (WHERE filled = 4)::text, 4) || ' of 25'
  FROM cells
 GROUP BY name, state
 ORDER BY sum(filled) DESC, name, state;"

# ===========================================================================
echo ""
echo "=== 4. EMPTY SCORER CELLS, NAMED =========================================="
echo ""
echo "  Every (payer, state, code, attribute) with no live rule, for the four"
echo "  attributes above. These are the questions the platform cannot answer"
echo "  from the library. Lanes with no in-scope rules at all are omitted here"
echo "  and listed whole in section 5."
echo ""
Q "$PRELUDE
, miss AS (
  SELECT lane.name, lane.state, a.attribute, a.ord, sc.code
    FROM lane CROSS JOIN scope sc CROSS JOIN attrs a
   WHERE a.scorer
     AND EXISTS (SELECT 1 FROM live l WHERE l.payer_id = lane.id AND l.state = lane.state)
     AND NOT EXISTS (
       SELECT 1 FROM live l
        WHERE l.payer_id = lane.id AND l.state = lane.state
          AND l.code = sc.code AND l.attribute = a.attribute))
, grp AS (
  SELECT name, state, attribute, ord, count(*) AS n,
         array_agg(code ORDER BY code) AS codes
    FROM miss GROUP BY name, state, attribute, ord)
, chunked AS (
  SELECT g.name, g.state, g.ord, (i - 1) / 10 AS chunk, g.codes[i] AS code
    FROM grp g, generate_subscripts(g.codes, 1) AS i
   WHERE g.n < 25)
, lines AS (
  SELECT name, state, ord, 0 AS sub,
         '  ' || rpad(left(name, 36) || ' /' || state, 41) || rpad(attribute, 22)
              || lpad(n::text, 2) || ' missing'
              || CASE WHEN n = 25 THEN '   <- every in-scope code' ELSE ':' END AS txt
    FROM grp
  UNION ALL
  SELECT name, state, ord, chunk + 1,
         '        ' || string_agg(code, ' ' ORDER BY code)
    FROM chunked GROUP BY name, state, ord, chunk)
SELECT txt FROM lines ORDER BY name, state, ord, sub;"
echo ""
Q "$PRELUDE
, miss AS (
  SELECT 1 AS x
    FROM lane CROSS JOIN scope sc CROSS JOIN attrs a
   WHERE a.scorer
     AND EXISTS (SELECT 1 FROM live l WHERE l.payer_id = lane.id AND l.state = lane.state)
     AND NOT EXISTS (
       SELECT 1 FROM live l
        WHERE l.payer_id = lane.id AND l.state = lane.state
          AND l.code = sc.code AND l.attribute = a.attribute))
SELECT '  TOTAL empty scorer cells in lanes that have some coverage: ' || count(*)::text
  FROM miss;"

# ===========================================================================
echo ""
echo "=== 5. Payers with NO in-scope rules at all ==============================="
echo ""
Q "$PRELUDE
, dead AS (
  SELECT lane.name, lane.state
    FROM lane
   WHERE NOT EXISTS (SELECT 1 FROM live l WHERE l.payer_id = lane.id AND l.state = lane.state))
SELECT txt FROM (
  SELECT 0 AS k, '' AS srt,
         CASE WHEN count(*) = 0 THEN '  (none - every lane has at least one in-scope rule)'
              ELSE '  ' || count(*)::text || ' lane(s), each with all 250 cells empty'
                        || ' (100 of them scorer cells):' END AS txt
    FROM dead
  UNION ALL
  SELECT 1, name || state,
         '    ' || rpad(left(name, 36) || ' /' || state, 41) || 'no live in-scope rule'
    FROM dead) z
 ORDER BY k, srt;"
echo ""
Q "$PRELUDE
SELECT '  Payers with no live rule for ANY code (not just in-scope): '
    || coalesce(string_agg(x.nm, ', ' ORDER BY x.nm), 'none')
  FROM (
    SELECT DISTINCT p.name::text AS nm
      FROM payer p
     WHERE p.active
       AND NOT EXISTS (SELECT 1 FROM payer_rule r
                        WHERE r.payer_id = p.id AND r.expiration_date IS NULL)) x;"

# ===========================================================================
echo ""
echo "=== 6. Payers below half the in-scope codes ==============================="
echo ""
echo "  'Covered' here means the code has at least one live rule of any"
echo "  attribute. Fewer than 13 of 25 is thin enough that a practice will hit"
echo "  an unanswerable code in normal billing."
echo ""
Q "$PRELUDE
, breadth AS (
  SELECT lane.name, lane.state, count(DISTINCT l.code) AS n
    FROM lane LEFT JOIN live l ON l.payer_id = lane.id AND l.state = lane.state
   GROUP BY lane.name, lane.state)
SELECT txt FROM (
  SELECT 0 AS k, 0 AS srt, '' AS srt2,
         CASE WHEN count(*) = 0 THEN '  (none - every lane covers 13 or more of the 25 codes)'
              ELSE '  ' || count(*)::text || ' lane(s) below half:' END AS txt
    FROM breadth WHERE n < 13
  UNION ALL
  SELECT 1, n, name || state,
         '    ' || rpad(left(name, 36) || ' /' || state, 41)
              || lpad(n::text, 3) || ' of 25 codes'
    FROM breadth WHERE n < 13) z
 ORDER BY k, srt, srt2;"

# ===========================================================================
echo ""
echo "=== 7. Rules the denial scorer cannot see ================================="
echo ""
echo "  payer_allowed_codes_v is anchored on the 'covered' rule: if a"
echo "  (payer, state, code) has no live 'covered' row, the code does not"
echo "  appear in the view AT ALL, and any prior_auth / modifier /"
echo "  frequency_limit rules filed against it are invisible to the scorer."
echo "  These rules exist, cost money to produce, and do nothing today."
echo ""
Q "$PRELUDE
, orphan AS (
  SELECT lane.name, lane.state, l.code
    FROM lane JOIN live l ON l.payer_id = lane.id AND l.state = lane.state
   GROUP BY lane.name, lane.state, l.code
  HAVING NOT bool_or(l.attribute = 'covered')
     AND bool_or(l.attribute IN ('prior_auth_required','modifier_required','frequency_limit')))
, agg AS (
  SELECT name, state, count(*) AS n, array_agg(code ORDER BY code) AS codes
    FROM orphan GROUP BY name, state)
, chunked AS (
  SELECT a.name, a.state, (i - 1) / 10 AS chunk, a.codes[i] AS code
    FROM agg a, generate_subscripts(a.codes, 1) AS i)
, lines AS (
  SELECT name, state, 0 AS sub,
         '  ' || rpad(left(name, 36) || ' /' || state, 41)
              || lpad(n::text, 3) || ' code(s) with hints but no coverage anchor:' AS txt
    FROM agg
  UNION ALL
  SELECT name, state, chunk + 1, '        ' || string_agg(code, ' ' ORDER BY code)
    FROM chunked GROUP BY name, state, chunk)
SELECT txt FROM lines ORDER BY name, state, sub;"
echo ""
Q "$PRELUDE
, orphan AS (
  SELECT lane.id, lane.state, l.code
    FROM lane JOIN live l ON l.payer_id = lane.id AND l.state = lane.state
   GROUP BY lane.id, lane.state, l.code
  HAVING NOT bool_or(l.attribute = 'covered'))
SELECT '  TOTAL (payer, state, code) with no coverage anchor: ' || count(DISTINCT (o.id::text || o.state || o.code))::text
    || '   unreachable rule rows: ' || count(*)::text
  FROM orphan o
  JOIN live l ON l.payer_id = o.id AND l.state = o.state AND l.code = o.code;"

# ===========================================================================
echo ""
echo "=== 8. Rules that exist but answer nothing ================================"
echo ""
echo "  value->>'answer' is the prose the platform shows a biller. A rule with"
echo "  no answer counts as a filled cell above but returns nothing readable."
echo ""
Q "$PRELUDE
, hollow AS (
  SELECT p.name::text AS name, r.state, r.code, r.attribute
    FROM payer_rule r
    JOIN scope sc ON sc.code = r.code
    JOIN payer p ON p.id = r.payer_id
   WHERE r.expiration_date IS NULL
     AND nullif(btrim(coalesce(r.value->>'answer', '')), '') IS NULL)
SELECT txt FROM (
  SELECT 0 AS k, '' AS srt,
         CASE WHEN count(*) = 0 THEN '  (none - every live in-scope rule carries an answer)'
              ELSE '  ' || count(*)::text || ' live in-scope rule(s) with an empty answer:' END AS txt
    FROM hollow
  UNION ALL
  SELECT 1, name || state || code || attribute,
         '    ' || rpad(left(name, 36) || ' /' || state, 41) || rpad(code, 8) || attribute
    FROM hollow) z
 ORDER BY k, srt;"

# ===========================================================================
echo ""
echo "=== 9. Integrity guards (these decide the exit code) ======================"
echo ""
echo "  Publishing gaps above are expected and do not fail. These five are"
echo "  different: each one means the library hands back a WRONG answer, or"
echo "  silently hides a rule, rather than admitting it does not know."
echo ""

check "one live rule per (payer,state,code,attribute) - no ties" 0 \
  "$(Q1 "$PRELUDE
, dup AS (
  SELECT r.payer_id, r.state, r.code, r.attribute
    FROM payer_rule r JOIN scope sc ON sc.code = r.code
   WHERE r.expiration_date IS NULL
   GROUP BY 1,2,3,4 HAVING count(*) > 1)
SELECT count(*) FROM dup;")"

check "no live in-scope rule filed under an unserved state" 0 \
  "$(Q1 "$PRELUDE
SELECT count(*) FROM payer_rule r
  JOIN scope sc ON sc.code = r.code
  JOIN payer p ON p.id = r.payer_id
 WHERE r.expiration_date IS NULL AND NOT (r.state = ANY (p.states_served));")"

check "no live in-scope rule dated to start in the future" 0 \
  "$(Q1 "$PRELUDE
SELECT count(*) FROM payer_rule r JOIN scope sc ON sc.code = r.code
 WHERE r.expiration_date IS NULL AND r.effective_date > CURRENT_DATE;")"

check "no live in-scope rule that is also marked superseded" 0 \
  "$(Q1 "$PRELUDE
SELECT count(*) FROM payer_rule r JOIN scope sc ON sc.code = r.code
 WHERE r.expiration_date IS NULL AND r.superseded_by IS NOT NULL;")"

check "every live in-scope rule carries a prose answer" 0 \
  "$(Q1 "$PRELUDE
SELECT count(*) FROM payer_rule r JOIN scope sc ON sc.code = r.code
 WHERE r.expiration_date IS NULL
   AND nullif(btrim(coalesce(r.value->>'answer', '')), '') IS NULL;")"

# ===========================================================================
echo ""
echo "=== 10. Totals and notes =================================================="
echo ""
Q "$PRELUDE
, cells AS (
  SELECT a.scorer,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM live l
            WHERE l.payer_id = lane.id AND l.state = lane.state
              AND l.code = sc.code AND l.attribute = a.attribute)) AS filled,
         count(*) AS total
    FROM lane CROSS JOIN scope sc CROSS JOIN attrs a
   GROUP BY a.scorer)
SELECT '  all cells        : ' || lpad(sum(filled)::text, 6) || ' filled of ' || lpad(sum(total)::text, 6)
    || '  (' || round(100.0 * sum(filled) / nullif(sum(total), 0), 1)::text || '%)' FROM cells
UNION ALL
SELECT '  scorer cells only: ' || lpad(sum(filled)::text, 6) || ' filled of ' || lpad(sum(total)::text, 6)
    || '  (' || round(100.0 * sum(filled) / nullif(sum(total), 0), 1)::text || '%)'
  FROM cells WHERE scorer;"
echo ""
Q "SELECT '  NOTE: 99343 is retired but has ' || count(*)::text
       || ' live rule(s) in the library.'
  FROM payer_rule WHERE code = '99343' AND expiration_date IS NULL
 HAVING count(*) > 0;"
Q "$PRELUDE
SELECT '  NOTE: ' || count(*)::text || ' live rule(s) exist outside the in-scope code list'
    || ' (other specialties - not audited here).'
  FROM payer_rule r
 WHERE r.expiration_date IS NULL
   AND r.code NOT IN (SELECT code FROM scope);"

echo ""
echo "==========================================================================="
printf ' Integrity guards: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo " FAILURES (send this line and the block above to the engineering team):"
  printf '%b\n' "$FAILURES"
  echo "==========================================================================="
  echo ""
  exit 1
fi
echo " Coverage gaps in sections 2-8 are a report, not a failure. Read them,"
echo " decide which payers are worth chasing documents for."
echo "==========================================================================="
echo ""
exit 0
