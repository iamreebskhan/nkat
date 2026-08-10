#!/usr/bin/env bash
# =============================================================================
#  audit-answers.sh  --  Pallio payer_rule library, LAYER 2
#  "Every stored answer, checked."
# =============================================================================
#
#  WHAT THIS PROVES
#  ----------------
#  It walks EVERY LIVE rule in payer_rule (expiration_date IS NULL) -- not a
#  sample, not a spot check -- and asserts, per rule:
#
#    A1  it carries a real verbatim source_quote (>= 20 chars)
#    A2  value->>'answer' exists and is a real prose answer (>= 40 chars)
#    A3  confidence is a number in [0,1]
#    A4  coverage_status is one of covered / not_covered / varies / unknown
#    A5  effective_date is not in the future
#    A6  source_doc_id resolves to a row in source_document
#    A7  that source_document carries a non-empty url
#    A8  attribute is one of the ten attributes the product answers on.
#        A failure here is a SCOPE finding, not corruption: it means the
#        library is storing rules on an attribute no screen ever shows.
#    A9  a "live" rule is not simultaneously marked superseded_by
#
#  Then it runs the CONTRADICTION HUNT -- the part that catches denials:
#
#    B1  LIMIT 1 INVARIANT.  fetchPayerRule() ends in LIMIT 1 with no
#        confidence tiebreak, so more than one live row for the same
#        (payer_id, state, code, attribute) means the answer a practice sees
#        is decided by Postgres row order.  Must be zero.
#    B2  SELF-CONTRADICTING COVERAGE.  A coverage answer whose prose says the
#        code is NOT covered while coverage_status says 'covered', or the
#        reverse.  The UI shows the badge; the biller reads the prose.
#    B3  ORPHAN PROMISE / SUBSTITUTION.  An answer that names a DIFFERENT
#        CPT/HCPCS code, where (i) that code is absent from the row's own
#        source quote, (ii) the code the row is filed under appears NOWHERE in
#        the row's value blob or quote, and (iii) no stated range brackets the
#        row's own code.  Restricted by default to answers naming exactly ONE
#        other code (see B3_MAX_OTHER below), because that is a rule filed
#        under the wrong code.  Answers that
#        enumerate several sibling codes ("99341-99350, 99497/99498, ...") are
#        normal policy prose, not defects -- that wider population is reported
#        as an INFO number in Section C rather than failed here.
#    B4  RETIRED CODE.  99343 was deleted from CPT for 2023.  No live rule may
#        say it is covered.
#    B5  HOME-HEALTH-AGENCY MIS-MAPPING.  A physician home-visit E/M row
#        (99341-99350, 99417, G0318) whose prior-auth answer repeats a home
#        health AGENCY benefit trigger -- "18 combined visits", "home health
#        aide", "private duty nursing", "home infusion" -- without a scope
#        disclaimer naming "home health agency".  Left unflagged, that single
#        mis-mapping tells every practice that every physician home visit
#        needs prior authorization.
#
#  WHAT THIS DELIBERATELY DOES NOT DO
#  ----------------------------------
#  * It NEVER calls the Anthropic API and never invokes lookupRule().  It reads
#    stored rows only.  Exercising empty (payer,code,attribute) cells would
#    fall through to RAG + Claude synthesis and bill thousands of API calls;
#    that is Layer 1's problem, not this script's.
#  * It is READ ONLY.  Every statement issued is a SELECT.  There is no INSERT,
#    UPDATE, DELETE, ALTER, CREATE or TRUNCATE anywhere in this file, and no
#    temp table.  It is safe to run against production during business hours.
#  * It does NOT use node, tsx or npx.  npx would try to download tsx and hang.
#    psql is the only dependency.
#  * It does NOT judge whether an answer is CORRECT against the payer's real
#    policy.  It cannot read UnitedHealthcare's manual.  It proves the library
#    is internally consistent, sourced, and free of the specific contradiction
#    classes above.  A confidently wrong but self-consistent answer passes.
#  * B2/B3/B5 are text heuristics.  They are tuned to fire on real problems
#    rather than on prose, but any row they print is a row for a human to read,
#    not an automatic defect.
#
#  USAGE
#  -----
#    bash scripts/audit-answers.sh              # production (sudo -u postgres)
#    PSQL_CMD="psql -h localhost -U postgres -d billing_rules" \
#        bash scripts/audit-answers.sh          # any other database
#
#  HOW TO READ THE OUTPUT
#  ----------------------
#  Every line is [PASS], [FAIL] or [INFO] followed by the number measured.
#  [PASS] means the number was zero.  [FAIL] prints the offending rows right
#  underneath, and every failed check is relisted at the very bottom so the
#  whole report can be pasted into an email as-is.  [INFO] lines are counts a
#  reviewer should see; they never fail the run.
#
#  EXIT CODES
#  ----------
#    0   every check passed
#    N   N checks failed (the failed check IDs are relisted at the bottom)
#    99  could not reach the database at all -- nothing was checked
# =============================================================================

set -uo pipefail

PSQL="${PSQL_CMD:-sudo -u postgres psql -d pallio}"
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"

MAX_ROWS_SHOWN=25

# B3 fails on answers naming at most this many OTHER codes.  1 = only
# unambiguous single-code substitutions.  Raise it (B3_MAX_OTHER=99) to widen
# B3 into a manual review queue over the whole Section C population.
B3_MAX_OTHER="${B3_MAX_OTHER:-1}"

FAIL_COUNT=0
PASS_COUNT=0
FAILED_SUMMARY=""

sql_scalar() { $PSQL -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
sql_table()  { $PSQL -X -q -v ON_ERROR_STOP=1 -P pager=off -P footer=off -c "$1"; }
# Prose findings are emitted as one text blob per row and word-wrapped here,
# because a 900-character-wide psql column is not something a human can read.
sql_record() { $PSQL -X -q -A -t -v ON_ERROR_STOP=1 -c "$1" | fold -s -w 92; }

hr() { printf '%s\n' "----------------------------------------------------------------------------"; }

# indent <n> -- pad non-blank lines only, so blank lines stay truly blank and
# the whole report survives a copy-paste into an email.
indent() { awk -v n="$1" 'BEGIN{p=sprintf("%" n "s","")} {print (length($0) ? p $0 : "")}'; }

# check <id> <label> <count-sql> <detail-sql> [table|record]
check() {
  local id="$1" label="$2" count_sql="$3" detail_sql="$4" mode="${5:-table}"
  local n
  n="$(sql_scalar "$count_sql")" || n=""
  if [ -z "$n" ]; then
    printf '  [ERR ] %-4s %-52s %s\n' "$id" "$label" "QUERY FAILED"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_SUMMARY="${FAILED_SUMMARY}  ${id}  ${label} -- QUERY FAILED\n"
    return
  fi
  if [ "$n" = "0" ]; then
    printf '  [PASS] %-4s %-52s %s\n' "$id" "$label" "0"
    PASS_COUNT=$((PASS_COUNT + 1))
    return
  fi

  printf '  [FAIL] %-4s %-52s %s\n' "$id" "$label" "$n"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_SUMMARY="${FAILED_SUMMARY}  ${id}  ${label} -- ${n} offending row(s)\n"
  printf '\n'
  if [ "$mode" = "record" ]; then
    sql_record "$detail_sql" | indent 6
  else
    sql_table "$detail_sql" | indent 6
  fi
  if [ "$n" -gt "$MAX_ROWS_SHOWN" ]; then
    printf '      ...and %s more offending row(s) not shown (showing first %s).\n' \
      "$((n - MAX_ROWS_SHOWN))" "$MAX_ROWS_SHOWN"
  fi
  printf '\n'
}

# note <id> <label> <count-sql> -- a measured number that is context, not a
# defect.  Never changes the exit code.
note() {
  local id="$1" label="$2" count_sql="$3" n
  n="$(sql_scalar "$count_sql")" || n="?"
  printf '  [INFO] %-4s %-52s %s\n' "$id" "$label" "${n:-?}"
}

# --- shared CTE: one normalized view of every LIVE rule -----------------------
# ans / hay are ASCII-folded so the regexes below cannot be defeated by
# en-dashes, smart quotes or non-breaking spaces in the ingested prose.
read -r -d '' LIVE <<'SQL'
with live as (
  select pr.id,
         pr.payer_id,
         coalesce(p.name::text,'(unknown payer)')            as payer,
         pr.state,
         pr.product_line,
         pr.code,
         pr.attribute,
         pr.coverage_status,
         pr.confidence,
         pr.effective_date,
         pr.superseded_by,
         pr.source_doc_id,
         coalesce(pr.source_quote,'')                        as quote,
         -- the prose the biller reads
         regexp_replace(coalesce(pr.value->>'answer',''), '[^ -~]', ' ', 'g') as ans,
         -- ONLY the verbatim payer text backing this rule.  Must exclude the
         -- answer, or "is this code actually in the quote?" is always true.
         regexp_replace(coalesce(pr.source_quote,'') || ' '
                        || coalesce(pr.value->>'supportingQuotes',''),
                        '[^ -~]', ' ', 'g')                  as evidence,
         -- everything stored on the row, for "is the row's own code named at all?"
         regexp_replace(pr.value::text || ' ' || coalesce(pr.source_quote,''),
                        '[^ -~]', ' ', 'g')                  as hay
  from payer_rule pr
  left join payer p on p.id = pr.payer_id
  where pr.expiration_date is null
)
SQL

# codes this product bills.  99343 is RETIRED and is handled by B4, not here.
HOME_EM="'99341','99342','99344','99345','99347','99348','99349','99350','99417','G0318'"
TEN_ATTRS="'covered','telehealth_allowed','prior_auth_required','provider_taxonomy_allowed','units_per_period_max','frequency_limit','modifier_required','documentation_required','bundled_with','pos_allowed'"

# =============================================================================
printf '\n'
printf '============================================================================\n'
printf ' PALLIO RULE LIBRARY AUDIT -- LAYER 2: EVERY STORED ANSWER, CHECKED\n'
printf '============================================================================\n'

DBINFO="$(sql_scalar "select current_database() || ' on ' || coalesce(inet_server_addr()::text,'local socket') || ' as of ' || current_date;")"
if [ -z "$DBINFO" ]; then
  printf '\n  Could not reach the database with: %s\n\n' "$PSQL"
  exit 99
fi
TOTAL_LIVE="$(sql_scalar "select count(*) from payer_rule where expiration_date is null;")"
TOTAL_PAYERS="$(sql_scalar "select count(distinct payer_id) from payer_rule where expiration_date is null;")"
TOTAL_DOCS="$(sql_scalar "select count(*) from source_document;")"

printf ' Database ......... %s\n' "$DBINFO"
printf ' Live rules ....... %s   (expiration_date IS NULL)\n' "$TOTAL_LIVE"
printf ' Payers ........... %s\n' "$TOTAL_PAYERS"
printf ' Source documents . %s\n' "$TOTAL_DOCS"
printf ' Mode ............. READ ONLY -- SELECT statements only, no API calls\n'
printf '============================================================================\n'

# =============================================================================
printf '\nSECTION A -- PER-RULE INTEGRITY   (every one of the %s live rules)\n' "$TOTAL_LIVE"
hr
printf '  RESULT  ID   CHECK                                                BAD ROWS\n'
hr

check A1 "Every rule carries a verbatim source_quote" \
"$LIVE select count(*) from live where length(btrim(quote)) < 20;" \
"$LIVE select payer, state, code, attribute,
          length(btrim(quote)) as quote_chars,
          case when btrim(quote) = '' then 'EMPTY / NULL' else 'TOO SHORT' end as problem
   from live where length(btrim(quote)) < 20 order by payer, code, attribute limit $MAX_ROWS_SHOWN;"

check A2 "Every rule has a prose answer of usable length" \
"$LIVE select count(*) from live where length(btrim(ans)) < 40;" \
"$LIVE select payer, state, code, attribute,
          length(btrim(ans)) as answer_chars,
          coalesce(nullif(btrim(ans),''),'EMPTY / NULL') as answer
   from live where length(btrim(ans)) < 40 order by payer, code, attribute limit $MAX_ROWS_SHOWN;"

check A3 "Confidence is a number between 0 and 1" \
"$LIVE select count(*) from live where confidence is null or confidence < 0 or confidence > 1;" \
"$LIVE select payer, state, code, attribute, confidence
   from live where confidence is null or confidence < 0 or confidence > 1
   order by confidence nulls first limit $MAX_ROWS_SHOWN;"

check A4 "coverage_status is one of the four valid values" \
"$LIVE select count(*) from live where coverage_status not in ('covered','not_covered','varies','unknown');" \
"$LIVE select payer, state, code, attribute, coverage_status
   from live where coverage_status not in ('covered','not_covered','varies','unknown')
   order by coverage_status limit $MAX_ROWS_SHOWN;"

check A5 "effective_date is on or before today" \
"$LIVE select count(*) from live where effective_date > current_date;" \
"$LIVE select payer, state, code, attribute, effective_date
   from live where effective_date > current_date order by effective_date desc limit $MAX_ROWS_SHOWN;"

check A6 "Cited source_document actually exists" \
"$LIVE select count(*) from live l left join source_document d on d.id = l.source_doc_id where d.id is null;" \
"$LIVE select l.payer, l.state, l.code, l.attribute, l.source_doc_id
   from live l left join source_document d on d.id = l.source_doc_id
   where d.id is null order by l.payer, l.code limit $MAX_ROWS_SHOWN;"

check A7 "Cited source_document has a non-empty url" \
"$LIVE select count(*) from live l join source_document d on d.id = l.source_doc_id where length(btrim(coalesce(d.url,''))) = 0;" \
"$LIVE select l.payer, l.state, l.code, l.attribute, coalesce(d.title,'(no title)') as doc_title
   from live l join source_document d on d.id = l.source_doc_id
   where length(btrim(coalesce(d.url,''))) = 0 order by l.payer, l.code limit $MAX_ROWS_SHOWN;"

check A8 "Attribute is one of the ten the product answers on" \
"$LIVE select count(*) from live where attribute not in ($TEN_ATTRS);" \
"$LIVE select attribute, count(*) as live_rules, min(code) as example_code
   from live where attribute not in ($TEN_ATTRS) group by attribute order by 2 desc limit $MAX_ROWS_SHOWN;"

check A9 "A live rule is not also marked superseded" \
"$LIVE select count(*) from live where superseded_by is not null;" \
"$LIVE select payer, state, code, attribute, superseded_by
   from live where superseded_by is not null order by payer, code limit $MAX_ROWS_SHOWN;"

# =============================================================================
printf '\nSECTION B -- CONTRADICTION HUNT   (the part that prevents denials)\n'
hr
printf '  RESULT  ID   CHECK                                                BAD ROWS\n'
hr

# --- B1: the LIMIT 1 invariant ------------------------------------------------
check B1 "LIMIT 1 invariant: one live row per payer/code/attr" \
"$LIVE select count(*) from (
   select payer_id, state, code, attribute from live
   group by 1,2,3,4 having count(*) > 1) dupes;" \
"$LIVE select payer, state, code, attribute, count(*) as live_rows,
          string_agg(distinct coverage_status, ' | ' order by coverage_status) as conflicting_statuses,
          string_agg(distinct confidence::text, ' | ') as confidences
   from live group by payer_id, payer, state, code, attribute
   having count(*) > 1 order by count(*) desc, payer, code limit $MAX_ROWS_SHOWN;"

# --- B2: prose contradicts the coverage badge ---------------------------------
# Scoped to attribute='covered', where coverage_status is a direct claim about
# the same question the prose answers.  On the other nine attributes the prose
# is routinely full of conditional non-coverage clauses ("services not ordered
# by a physician are not covered") that are not contradictions at all, so
# including them would bury a real hit under false positives.
B2_NEG="(is|are) not (separately )?covered|does not (separately )?cover|is non-covered|no coverage (is|exists)|is excluded from coverage|is not (a )?(payable|reimbursable|billable)"
B2_POS="(is|are) (a )?covered|will be (paid|covered)|is payable|is reimbursable"
B2_POS_NEG_GUARD="not covered|does not cover|non-covered|not a covered|not payable|not reimbursable|not separately"

check B2 "Coverage prose agrees with the coverage_status badge" \
"$LIVE select count(*) from live where attribute = 'covered' and (
     (coverage_status = 'covered'     and ans ~* '$B2_NEG')
  or (coverage_status = 'not_covered' and ans ~* '$B2_POS' and ans !~* '$B2_POS_NEG_GUARD'));" \
"$LIVE select '* ' || code || '  ' || state || '  ' || payer
          || '  [badge says: ' || coverage_status || ']' || chr(10)
          || '    PROSE: ' || left(ans, 400) || chr(10)
   from live where attribute = 'covered' and (
     (coverage_status = 'covered'     and ans ~* '$B2_NEG')
  or (coverage_status = 'not_covered' and ans ~* '$B2_POS' and ans !~* '$B2_POS_NEG_GUARD'))
   order by payer, code limit $MAX_ROWS_SHOWN;" \
record

# --- B3: orphan promise -------------------------------------------------------
# Fires when the answer names some OTHER CPT/HCPCS code and the row's own code
# is absent from the entire value blob AND the source quote -- with an
# exemption when the answer states a numeric range that brackets the own code.
read -r -d '' B3_BODY <<SQL
$LIVE
-- a code named inside a range the answer states (e.g. "99341-99350") counts as
-- naming every code the range brackets, so sibling-range prose is not a defect.
, ranges as (
  select l.id,
         bool_or(l.code ~ '^9[0-9]{4}\$'
                 and l.code::int between (r[1])::int and (r[2])::int) as bracketed
  from live l,
       lateral regexp_matches(l.ans || ' ' || l.evidence,
         '(9[0-9]{4})[[:space:]]*(?:-|to|through|thru)?[[:space:]]*(9[0-9]{4})', 'g') r
  group by l.id
),
mentions as (
  select l.*,
         (regexp_matches(l.ans,
            '(?:^|[^0-9A-Za-z])((?:9[0-9]{4})|(?:[A-HJ-VX-Z][0-9]{4}))(?![0-9A-Za-z])', 'g'))[1] as mentioned
  from live l
),
scored as (
  select m.id, m.payer, m.state, m.code, m.attribute, m.ans,
         count(distinct m.mentioned) filter (where m.mentioned <> m.code)          as other_codes,
         count(distinct m.mentioned) filter (where m.mentioned <> m.code
                                              and position(m.mentioned in m.evidence) = 0) as unbacked_codes,
         string_agg(distinct m.mentioned, ', ' order by m.mentioned)
           filter (where m.mentioned <> m.code)                                    as promises_instead,
         bool_or(position(m.code in m.hay) > 0)                                    as own_code_present,
         bool_or(coalesce(g.bracketed, false))                                     as bracketed
  from mentions m
  left join ranges g on g.id = m.id
  group by m.id, m.payer, m.state, m.code, m.attribute, m.ans
),
-- the row's own code is named NOWHERE on the row, and its answer is really
-- about some other code that its own quote does not support either
orphans as (
  select * from scored
  where unbacked_codes > 0
    and own_code_present = false
    and bracketed = false
),
-- SUBSTITUTION: the answer names exactly ONE other code.  That is a rule filed
-- under the wrong code, not an answer that happens to enumerate siblings.
substitutions as (select * from orphans where other_codes <= $B3_MAX_OTHER)
SQL

check B3 "Answer never substitutes a different single code" \
"$B3_BODY select count(*) from substitutions;" \
"$B3_BODY select '* filed under ' || code || '  ' || state || '  ' || payer
          || '  [' || attribute || ']' || chr(10)
          || '    the answer is about ' || promises_instead
          || ', which its own source quote does not mention either' || chr(10)
          || '    ANSWER: ' || left(ans, 400) || chr(10)
   from substitutions order by payer, code, attribute limit $MAX_ROWS_SHOWN;" \
record

# --- B4: retired code ---------------------------------------------------------
check B4 "Retired code 99343 is never marked covered" \
"$LIVE select count(*) from live where code = '99343' and coverage_status = 'covered';" \
"$LIVE select '* 99343  ' || state || '  ' || payer || '  [' || attribute
          || ', effective ' || effective_date || ']' || chr(10)
          || '    ANSWER: ' || left(ans, 400) || chr(10)
   from live where code = '99343' and coverage_status = 'covered'
   order by payer, attribute limit $MAX_ROWS_SHOWN;" \
record

# --- B5: home health AGENCY trigger leaking onto a physician home visit --------
B5_TRIGGER="18 combined visits|home health aide|private duty nursing|home infusion"

check B5 "Home-visit E/M prior-auth free of agency triggers" \
"$LIVE select count(*) from live
   where code in ($HOME_EM) and attribute in ('prior_auth_required','covered')
     and hay ~* '$B5_TRIGGER' and hay !~* 'home health agency';" \
"$LIVE select '* ' || code || '  ' || state || '  ' || payer
          || '  [' || attribute || ']' || chr(10)
          || '    agency-benefit wording found, no \"home health agency\" scope disclaimer' || chr(10)
          || '    ANSWER: ' || left(ans, 500) || chr(10)
   from live
   where code in ($HOME_EM) and attribute in ('prior_auth_required','covered')
     and hay ~* '$B5_TRIGGER' and hay !~* 'home health agency'
   order by payer, code limit $MAX_ROWS_SHOWN;" \
record

# =============================================================================
printf '\nSECTION C -- WHAT WAS WALKED   (context, not a pass/fail)\n'
hr

# Numbers a reviewer should see but which are NOT defects on their own.
note C1 "Rules whose own code is named nowhere on the row" \
"$LIVE select count(*) from live where position(code in hay) = 0;"
note C2 "...of those, answers that enumerate other codes" \
"$B3_BODY select count(*) from orphans;"
printf '        (C1/C2 are prose written as general policy rather than\n'
printf '         code-by-code.  Reviewable, not broken.  B3 above fails only\n'
printf '         on the unambiguous single-code substitutions.)\n'

printf '\n  Live rules by attribute\n\n'
sql_table "$LIVE
select attribute,
       count(*)                                        as live_rules,
       count(distinct payer_id)                        as payers,
       count(distinct code)                            as codes,
       count(*) filter (where coverage_status='covered')     as covered,
       count(*) filter (where coverage_status='not_covered') as not_covered,
       count(*) filter (where coverage_status='varies')      as varies,
       count(*) filter (where coverage_status='unknown')     as unknown
from live group by attribute order by live_rules desc;" | indent 2

printf '\n  Live rules by billed code (home-based palliative care scope)\n\n'
sql_table "$LIVE
select code,
       count(*)                 as live_rules,
       count(distinct payer_id) as payers,
       count(distinct attribute) as attributes
from live
where code in ($HOME_EM,'99343','99497','99498','G0179','G0180','G0181',
                '99495','99496','99490','99439','99491','99424','99425',
                '99426','99427','99499')
group by code order by code;" | indent 2

# =============================================================================
printf '\n'
printf '============================================================================\n'
printf ' RESULT\n'
printf '============================================================================\n'
printf ' Checks run ....... %s\n' "$((PASS_COUNT + FAIL_COUNT))"
printf ' Passed ........... %s\n' "$PASS_COUNT"
printf ' Failed ........... %s\n' "$FAIL_COUNT"
printf ' Live rules walked  %s\n' "$TOTAL_LIVE"

if [ "$FAIL_COUNT" -eq 0 ]; then
  printf '\n ALL CHECKS PASSED.  Every one of the %s live rules is sourced,\n' "$TOTAL_LIVE"
  printf ' internally consistent, and free of the contradiction classes above.\n'
  printf '============================================================================\n\n'
  exit 0
fi

printf '\n FAILURES -- send this list to the rules team:\n\n'
printf "%b" "$FAILED_SUMMARY"
printf '\n Offending rows are printed above, under each failed check.\n'
printf '============================================================================\n\n'
exit "$FAIL_COUNT"
