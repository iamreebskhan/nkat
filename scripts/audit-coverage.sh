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
#    11. how much of all of the above survives a BACK-DATED date of service
#
# WHAT "LIVE" MEANS HERE
#
#   fetchPayerRule() serves a rule when
#
#     effective_date <= dos AND (expiration_date IS NULL OR expiration_date > dos)
#
#   Not `expiration_date IS NULL`. Earlier versions of this script used IS NULL,
#   which is a different set: a rule given a FUTURE expiration_date — the normal
#   way to schedule an annual sunset — is served in production and is invisible
#   to an IS NULL test, and a rule with a future effective_date is not served
#   even though IS NULL calls it live.
#
#   Every count is taken at a DATE OF SERVICE, default CURRENT_DATE, overridable
#   with AUDIT_DOS=YYYY-MM-DD. Section 11 re-measures at 90 / 180 / 365 days
#   back, because practices re-work denials inside the timely-filing window and
#   the library answers a DIFFERENT question at those dates.
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

# Date of service every count is taken at. Interpolated into SQL, so validated.
AUDIT_DOS="${AUDIT_DOS:-}"
if [ -n "$AUDIT_DOS" ]; then
  case "$AUDIT_DOS" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) echo "FATAL: AUDIT_DOS must be YYYY-MM-DD, got '$AUDIT_DOS'"; exit 2 ;;
  esac
  DOS_SQL="DATE '$AUDIT_DOS'"
else
  DOS_SQL="CURRENT_DATE"
fi

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
#   live  — in-scope rules SERVED AT THE AUDIT DOS. That is fetchPayerRule's
#           own predicate, not expiration_date IS NULL. See the header.
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
   WHERE r.effective_date <= $DOS_SQL
     AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL))
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
UNION ALL SELECT '  date of service    : ' || ($DOS_SQL)::text
       || ' (override with AUDIT_DOS=YYYY-MM-DD)'
UNION ALL SELECT '  live rules in scope : ' || count(*)::text
       || '   [effective_date <= DOS AND (expiration_date IS NULL OR expiration_date > DOS)]'
     FROM live
UNION ALL SELECT '  for comparison      : ' || count(*)::text
       || '   would match the OLD, WRONG test  expiration_date IS NULL'
     FROM payer_rule r JOIN scope sc ON sc.code = r.code WHERE r.expiration_date IS NULL;"
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
                        WHERE r.payer_id = p.id AND r.effective_date <= $DOS_SQL AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL))) x;"

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
echo "  TWO different populations are reported below, because they are two"
echo "  different things and an earlier version of this script listed one and"
echo "  totalled the other:"
echo "    (a) LISTED  — anchorless (payer,state,code) that carry at least one"
echo "        prior_auth / modifier / frequency rule. Money was spent on a"
echo "        scorer input the scorer cannot reach."
echo "    (b) WIDER   — every anchorless (payer,state,code), including those"
echo "        carrying only non-scorer attributes. (a) is a subset of (b)."
echo ""

# ONE CTE chain feeds the listing, the (a) total and the (b) total, so the
# three numbers cannot drift apart again.
ORPHAN_CTE="$PRELUDE
, anchorless AS (
  SELECT lane.id, lane.name, lane.state, l.code,
         bool_or(l.attribute IN ('prior_auth_required','modifier_required','frequency_limit'))
           AS has_scorer_hint
    FROM lane JOIN live l ON l.payer_id = lane.id AND l.state = lane.state
   GROUP BY lane.id, lane.name, lane.state, l.code
  HAVING NOT bool_or(l.attribute = 'covered'))
"

Q "$ORPHAN_CTE
, listed AS (SELECT * FROM anchorless WHERE has_scorer_hint)
, agg AS (
  SELECT name, state, count(*) AS n, array_agg(code ORDER BY code) AS codes
    FROM listed GROUP BY name, state)
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
# Keep SQL string literals ASCII-only. These queries are handed to psql as a
# -c argument; on a Windows shell the argument is re-encoded in the ANSI
# codepage, so a UTF-8 em dash arrives as a lone 0x97 byte and psql rejects the
# whole statement as an invalid byte sequence. Prose in echo lines is fine.
Q "$ORPHAN_CTE
, rows_on AS (
  SELECT a.has_scorer_hint, l.attribute
    FROM anchorless a
    JOIN live l ON l.payer_id = a.id AND l.state = a.state AND l.code = a.code)
SELECT '  (a) LISTED ABOVE - anchorless (payer,state,code) WITH scorer hints : '
    || lpad((SELECT count(*)::text FROM anchorless WHERE has_scorer_hint), 4)
UNION ALL
SELECT '      ...the rule rows sitting on them, unreachable by the scorer   : '
    || lpad((SELECT count(*)::text FROM rows_on WHERE has_scorer_hint), 4)
UNION ALL
SELECT '      ...of which are actual scorer inputs (PA / MOD / FRQ)         : '
    || lpad((SELECT count(*)::text FROM rows_on
              WHERE has_scorer_hint
                AND attribute IN ('prior_auth_required','modifier_required','frequency_limit')), 4)
UNION ALL
SELECT '  (b) WIDER  - every anchorless (payer,state,code), hints or not    : '
    || lpad((SELECT count(*)::text FROM anchorless), 4)
    || '   <- NOT the list above'
UNION ALL
SELECT '      ...the rule rows sitting on them                              : '
    || lpad((SELECT count(*)::text FROM rows_on), 4);"

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
   -- Served predicate, not IS NULL. Section 9 guards this same set with
   -- the same served predicate; when the two disagreed, section 8 printed
   -- "none" while the guard directly below it FAILED on the same rules.
   WHERE r.effective_date <= $DOS_SQL
     AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL)
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
echo "  Publishing gaps above are expected and do not fail. These guards are"
echo "  different: each one means the library hands back a WRONG answer, or"
echo "  silently hides a rule, rather than admitting it does not know."
echo ""
echo "  Every guard here can come out either way — none of them restates a"
echo "  constraint the schema already enforces. A guard that cannot fail is"
echo "  not an assurance, and is not printed."
echo ""

SERVED="r.effective_date <= $DOS_SQL AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL)"

check "one live rule per (payer,state,code,attribute) - no ties" 0 \
  "$(Q1 "$PRELUDE
, dup AS (
  SELECT r.payer_id, r.state, r.code, r.attribute
    FROM payer_rule r JOIN scope sc ON sc.code = r.code
   WHERE $SERVED
   GROUP BY 1,2,3,4 HAVING count(*) > 1)
SELECT count(*) FROM dup;")"

# The same invariant at a BACK-DATED date of service. The guard above asks at
# today only; a denial is re-worked at the DOS on the claim, months back, where
# a DIFFERENT set of rows is served. `expiration_date IS NULL` has no notion of
# a date and cannot ask this question at all. Counted as DISTINCT keys, so a key
# ambiguous at two dates is one broken key, not two.
check "...and at 90/180/365 days back (timely-filing window)" 0 \
  "$(Q1 "$PRELUDE
, back(dos) AS (VALUES ($DOS_SQL - 90), ($DOS_SQL - 180), ($DOS_SQL - 365))
, dup AS (
  SELECT b.dos, r.payer_id, r.state, r.code, r.attribute
    FROM back b
    JOIN payer_rule r ON r.effective_date <= b.dos
                     AND (r.expiration_date IS NULL OR r.expiration_date > b.dos)
    JOIN scope sc ON sc.code = r.code
   GROUP BY 1,2,3,4,5 HAVING count(*) > 1)
SELECT count(*) FROM (SELECT DISTINCT payer_id, state, code, attribute FROM dup) k;")"

check "no live in-scope rule filed under an unserved state" 0 \
  "$(Q1 "$PRELUDE
SELECT count(*) FROM payer_rule r
  JOIN scope sc ON sc.code = r.code
  JOIN payer p ON p.id = r.payer_id
 WHERE $SERVED AND NOT (r.state = ANY (p.states_served));")"

check "no live in-scope rule that is also marked superseded" 0 \
  "$(Q1 "$PRELUDE
SELECT count(*) FROM payer_rule r JOIN scope sc ON sc.code = r.code
 WHERE $SERVED AND r.superseded_by IS NOT NULL;")"

check "every live in-scope rule carries a prose answer" 0 \
  "$(Q1 "$PRELUDE
SELECT count(*) FROM payer_rule r JOIN scope sc ON sc.code = r.code
 WHERE $SERVED
   AND nullif(btrim(coalesce(r.value->>'answer', '')), '') IS NULL;")"

# The old guard "no live in-scope rule dated to start in the future" is GONE,
# not silently passing: under the correct served predicate it is true by
# construction (effective_date <= DOS is part of the definition), so printing
# it as PASS would have been a tautology dressed as an assurance. The number it
# used to stand for — rules not yet in effect — is in section 11.

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
 WHERE r.effective_date <= $DOS_SQL
   AND (r.expiration_date IS NULL OR r.expiration_date > $DOS_SQL)
   AND r.code NOT IN (SELECT code FROM scope);"

# ===========================================================================
echo ""
echo "=== 11. The same matrix at a BACK-DATED date of service ==================="
echo ""
echo "  Everything above is measured at one date. A practice re-working a"
echo "  denial asks the library about the DOS on the CLAIM, which is inside the"
echo "  timely-filing window and months in the past — and the library serves a"
echo "  DIFFERENT set of rules at that date. A cell that answers today is not"
echo "  evidence that it answered when the service was rendered."
echo ""
printf '  %-14s%-13s%9s%9s%9s%9s%11s\n' "AT DOS" "DATE" "RULES" "CELLS" "SCORER" "LANES" "AMBIGUOUS"
Q "$PRELUDE
, back(ord, lbl, dos) AS (VALUES
    (1,'today',     $DOS_SQL),
    (2,'90d back',  $DOS_SQL - 90),
    (3,'180d back', $DOS_SQL - 180),
    (4,'365d back', $DOS_SQL - 365))
, served AS (
  SELECT b.ord, b.lbl, b.dos, r.payer_id, r.state, r.code, r.attribute
    FROM back b
    JOIN payer_rule r ON r.effective_date <= b.dos
                     AND (r.expiration_date IS NULL OR r.expiration_date > b.dos)
    JOIN scope sc ON sc.code = r.code)
, agg AS (
  SELECT s.ord, s.lbl, s.dos,
         count(*)                                                          AS rules,
         count(DISTINCT (s.payer_id::text||s.state||s.code||s.attribute))  AS cells,
         count(*) FILTER (WHERE s.attribute IN
           ('covered','prior_auth_required','modifier_required','frequency_limit')) AS scorer,
         count(DISTINCT (s.payer_id::text||s.state))                       AS lanes
    FROM served s GROUP BY s.ord, s.lbl, s.dos)
SELECT '  ' || rpad(lbl, 14) || rpad(dos::text, 13)
    || lpad(rules::text, 9) || lpad(cells::text, 9)
    || lpad(scorer::text, 9) || lpad(lanes::text, 9)
    || lpad((rules - cells)::text, 11)
  FROM agg ORDER BY ord;"
echo ""
echo "  RULES     = in-scope rule rows served at that DOS"
echo "  CELLS     = distinct (payer,state,code,attribute) answered"
echo "  SCORER    = of those rows, the four attributes the denial scorer reads"
echo "  LANES     = distinct payer x state answering anything"
echo "  AMBIGUOUS = RULES minus CELLS. Anything above 0 means more than one"
echo "              rule is live on one key at that date, and fetchPayerRule"
echo "              ends in LIMIT 1 with no tiebreak — Postgres row order picks"
echo "              the answer. Guard 2 in section 9 fails on this."
echo ""
Q "$PRELUDE
SELECT '  Divergence between the two definitions of live, at ' || ($DOS_SQL)::text || ':'
UNION ALL
SELECT '    in-scope rows matching  expiration_date IS NULL          : '
    || (SELECT count(*)::text FROM payer_rule r JOIN scope sc ON sc.code = r.code
         WHERE r.expiration_date IS NULL)
UNION ALL
SELECT '    in-scope rows actually SERVED at this DOS                : '
    || (SELECT count(*)::text FROM live)
UNION ALL
SELECT '    served, but IS NULL misses them (future expiration_date)  : '
    || (SELECT count(*)::text FROM payer_rule r JOIN scope sc ON sc.code = r.code
         WHERE r.expiration_date IS NOT NULL AND r.expiration_date > $DOS_SQL
           AND r.effective_date <= $DOS_SQL)
    || '   <- served in production, invisible to the old test'
UNION ALL
SELECT '    IS NULL calls them live, but they are not served yet      : '
    || (SELECT count(*)::text FROM payer_rule r JOIN scope sc ON sc.code = r.code
         WHERE r.expiration_date IS NULL AND r.effective_date > $DOS_SQL);"
echo ""
echo "  If the two middle lines are equal the definitions happen to coincide at"
echo "  this date. That is a property of today's data, not of the test: it stops"
echo "  holding the moment anyone schedules a sunset, and the table above shows"
echo "  they already disagree at every other date of service."

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
