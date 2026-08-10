#!/usr/bin/env bash
# =============================================================================
#  audit-answers.sh  --  Pallio payer_rule library, LAYER 2
#  "Every stored answer, checked."
# =============================================================================
#
#  WHAT "LIVE" MEANS HERE
#  ----------------------
#  fetchPayerRule() serves a rule when
#
#      effective_date <= dos  AND  (expiration_date IS NULL OR expiration_date > dos)
#
#  That -- not `expiration_date IS NULL` -- is the definition this script uses,
#  because it is the definition production uses.  The two are NOT the same set:
#  a rule given a FUTURE expiration_date (the normal way to schedule an annual
#  sunset) is served today and is invisible to any check keyed on IS NULL, and a
#  rule with a future effective_date is not served today even though IS NULL
#  calls it live.  Section D prints the divergence rather than assuming it away.
#
#  Every check below is evaluated at a DATE OF SERVICE, default CURRENT_DATE.
#  Override with AUDIT_DOS=2025-09-01.  Practices re-work denials inside the
#  timely-filing window, so Section D re-measures at 90 / 180 / 365 days back.
#
#  WHAT THIS PROVES
#  ----------------
#  It walks EVERY rule live at the audit DOS -- not a sample, not a spot
#  check -- and asserts, per rule:
#
#    A1  it carries a real verbatim source_quote (>= 20 chars)
#    A2  value->>'answer' exists and is a real prose answer (>= 40 chars)
#    A7  the cited source_document carries a non-empty url
#    A8  attribute is one of the ten attributes the product answers on.
#        A failure here is a SCOPE finding, not corruption: it means the
#        library is storing rules on an attribute no screen ever shows.
#    A9  a live rule is not simultaneously marked superseded_by
#
#  STRUCTURAL GUARANTEES -- PRINTED, BUT NOT EVIDENCE
#  --------------------------------------------------
#  Three things this script used to present as passing checks CANNOT FAIL,
#  because the schema already forbids the failure.  They are printed as [STRC]
#  with the constraint that enforces them, and they are NOT counted in the pass
#  tally -- a reader must not be able to mistake "the column is NOT NULL" for
#  "somebody verified 5,665 rows".
#
#    S1  confidence in [0,1]         payer_rule_confidence_check + NOT NULL
#    S2  coverage_status in 4 values payer_rule_coverage_status_check + NOT NULL
#    S3  citation resolves           payer_rule_source_doc_id_fkey + NOT NULL
#
#  If any of those constraints is ever dropped, the guarantee stops being
#  structural and the line degrades into a real, counted check on the spot.
#
#  The old A5 ("effective_date is not in the future") is gone for the same
#  reason: under the correct live predicate it is true by construction.  The
#  number it used to stand in for -- rules not yet in effect -- is in Section D.
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
#    B6  LIMIT 1 INVARIANT AT A BACK-DATED DOS.  B1 asks the question at today
#        only.  A practice appealing a denial asks it at the DOS on the claim,
#        which is months back, and the set served at that DOS is a DIFFERENT
#        set of rows.  B6 re-runs the duplicate-key test at 90, 180 and 365
#        days back.  A duplicate there is the same defect as a duplicate today
#        -- Postgres row order decides the answer -- and the IS NULL definition
#        cannot see it at all.
#
#  SECTION C -- VISIBILITY, NOT FAILURE
#  ------------------------------------
#  C3 counts rules whose prose names a DIFFERENT code and never their own.
#  C4 counts rules stamped value->>'mappedFrom' = 'service-level rule mapped to
#  this code', which is the pipeline saying "this is a general policy attached
#  to a specific code".  Service-level mapping is legitimate and deliberate.
#  Neither is a defect and neither fails the run -- but the VOLUME belongs on
#  the page, because it is the difference between "we read a policy about
#  99349" and "we read a policy about home visits and filed it under 99349".
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
#  Every line is [PASS], [FAIL], [STRC] or [INFO] followed by the number
#  measured.  [PASS] means the number was zero.  [FAIL] prints the offending
#  rows right underneath, and every failed check is relisted at the very bottom
#  so the whole report can be pasted into an email as-is.  [STRC] is a schema
#  constraint restated -- it is not evidence and is not counted.  [INFO] lines
#  are counts a reviewer should see; they never fail the run.
#
#  The footer tally counts ONLY the checks that could have come out either way.
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

# The date of service every check is evaluated at.  Default today.  Must be a
# bare ISO date -- it is interpolated into SQL, so it is validated here.
AUDIT_DOS="${AUDIT_DOS:-}"
if [ -n "$AUDIT_DOS" ]; then
  case "$AUDIT_DOS" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) printf 'FATAL: AUDIT_DOS must be YYYY-MM-DD, got "%s"\n' "$AUDIT_DOS" >&2; exit 2 ;;
  esac
  DOS_SQL="date '$AUDIT_DOS'"
else
  DOS_SQL="current_date"
fi

# The one definition of "live" in this file: fetchPayerRule()'s own predicate.
# served <alias> [<dos-expr>] -- every query below is built from this single
# function, so no query can drift back to `expiration_date IS NULL`.
served() {
  local a="$1" d="${2:-$DOS_SQL}"
  printf '%s.effective_date <= %s and (%s.expiration_date is null or %s.expiration_date > %s)' \
    "$a" "$d" "$a" "$a" "$d"
}
SERVED_PR="$(served pr)"

FAIL_COUNT=0
PASS_COUNT=0
STRUCT_COUNT=0
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

# guarantee <id> <label> <enforced-sql> <constraint-name> <count-sql> <detail-sql>
#
# For a property the SCHEMA already forbids violating.  Printed so a reader can
# see it was considered, labelled [STRC] so nobody reads it as an independent
# assurance, and deliberately NOT counted in the pass tally.
#
# <enforced-sql> must return 't' when the constraint is still in place.  If it
# ever returns 'f' -- somebody dropped the constraint -- the property stops
# being structural and this degrades into a real, counted check on the spot.
guarantee() {
  local id="$1" label="$2" cname="$3" notnull_col="$4" count_sql="$5" detail_sql="$6"
  local cdef notnull
  cdef="$(sql_scalar "select coalesce(pg_get_constraintdef(oid),'') from pg_constraint
                       where conrelid = 'payer_rule'::regclass and conname = '$cname';")"
  # boolean::text renders as 'true'/'false' here, but psql's unaligned output
  # has printed 't'/'f' on other builds -- accept either rather than silently
  # reporting a live constraint as missing.
  notnull="$(sql_scalar "select case when coalesce(bool_and(attnotnull),false) then 'yes' else 'no' end
                           from pg_attribute
                          where attrelid = 'payer_rule'::regclass and attname = '$notnull_col';")"
  if [ -n "$cdef" ] && [ "$notnull" = "yes" ]; then
    printf '  [STRC] %-4s %-52s %s\n' "$id" "$label" "schema"
    printf '              %s NOT NULL, and %s\n' "$notnull_col" "$cname"
    printf '              %s\n' "$cdef" | cut -c1-92
    printf '              cannot fail -> restated, NOT evidence, NOT counted in the tally\n'
    STRUCT_COUNT=$((STRUCT_COUNT + 1))
    return
  fi
  printf '  [!!!!] %-4s %-52s %s\n' "$id" "$label" "ENFORCEMENT GONE"
  printf '              %s missing or %s is nullable -- this is a REAL check now:\n' "$cname" "$notnull_col"
  check "$id" "$label" "$count_sql" "$detail_sql"
}

# note <id> <label> <count-sql> -- a measured number that is context, not a
# defect.  Never changes the exit code.
note() {
  local id="$1" label="$2" count_sql="$3" n
  n="$(sql_scalar "$count_sql")" || n="?"
  printf '  [INFO] %-4s %-52s %s\n' "$id" "$label" "${n:-?}"
}

# --- shared CTE: one normalized view of every rule SERVED AT THE AUDIT DOS ----
# The WHERE clause is fetchPayerRule()'s own predicate, not `expiration_date IS
# NULL`.  ans / hay are ASCII-folded so the regexes below cannot be defeated by
# en-dashes, smart quotes or non-breaking spaces in the ingested prose.
read -r -d '' LIVE <<SQL
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
         pr.value->>'mappedFrom'                             as mapped_from,
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
  where $SERVED_PR
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
AUDIT_DATE="$(sql_scalar "select ($DOS_SQL)::text;")"
TOTAL_LIVE="$(sql_scalar "select count(*) from payer_rule pr where $SERVED_PR;")"
TOTAL_PAYERS="$(sql_scalar "select count(distinct payer_id) from payer_rule pr where $SERVED_PR;")"
TOTAL_DOCS="$(sql_scalar "select count(*) from source_document;")"
TOTAL_EXPNULL="$(sql_scalar "select count(*) from payer_rule where expiration_date is null;")"

printf ' Database ......... %s\n' "$DBINFO"
printf ' Date of service .. %s%s\n' "$AUDIT_DATE" \
  "$( [ -n "$AUDIT_DOS" ] && printf '   (AUDIT_DOS override)' || printf '   (today; override with AUDIT_DOS=YYYY-MM-DD)' )"
printf ' Live rules ....... %s   (effective_date <= DOS AND (expiration_date IS NULL OR expiration_date > DOS)\n' "$TOTAL_LIVE"
printf '                    %s   -- what fetchPayerRule actually serves)\n' ''
printf ' For comparison ... %s rows match the OLD, WRONG test `expiration_date IS NULL`\n' "$TOTAL_EXPNULL"
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
printf '\nSECTION S -- STRUCTURAL GUARANTEES   (restated, NOT evidence)\n'
hr
printf '  These three cannot come out any other way: the schema rejects the bad\n'
printf '  row at INSERT time.  They were previously printed as [PASS] and counted\n'
printf '  in the tally, which read as three independent assurances.  They are not.\n'
hr

guarantee S1 "Confidence is a number between 0 and 1" \
  payer_rule_confidence_check confidence \
"$LIVE select count(*) from live where confidence is null or confidence < 0 or confidence > 1;" \
"$LIVE select payer, state, code, attribute, confidence
   from live where confidence is null or confidence < 0 or confidence > 1
   order by confidence nulls first limit $MAX_ROWS_SHOWN;"

guarantee S2 "coverage_status is one of the four valid values" \
  payer_rule_coverage_status_check coverage_status \
"$LIVE select count(*) from live where coverage_status not in ('covered','not_covered','varies','unknown');" \
"$LIVE select payer, state, code, attribute, coverage_status
   from live where coverage_status not in ('covered','not_covered','varies','unknown')
   order by coverage_status limit $MAX_ROWS_SHOWN;"

guarantee S3 "Cited source_document actually exists" \
  payer_rule_source_doc_id_fkey source_doc_id \
"$LIVE select count(*) from live l left join source_document d on d.id = l.source_doc_id where d.id is null;" \
"$LIVE select l.payer, l.state, l.code, l.attribute, l.source_doc_id
   from live l left join source_document d on d.id = l.source_doc_id
   where d.id is null order by l.payer, l.code limit $MAX_ROWS_SHOWN;"

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
# Exempt any rule whose own VERBATIM QUOTE names the code. When the payer
# writes the code down there is no service-to-code mapping to get wrong,
# and the trigger words are then just the category heading the code was
# listed under. Humana Healthy Horizons SC is the real case: its PAL reads
#   'Prior authorization required after five visits for the following
#    codes: 99344, 99501, 99502, ...'
# under a 'Home health/home infusion' heading. The rule is correct; the
# heading is not evidence of a mis-mapping.
B5_TRIGGER="18 combined visits|home health aide|private duty nursing|home infusion"

check B5 "Home-visit E/M prior-auth free of agency triggers" \
"$LIVE select count(*) from live
   where code in ($HOME_EM) and attribute in ('prior_auth_required','covered')
     and hay ~* '$B5_TRIGGER' and hay !~* 'home health agency'
     and quote !~ ('(^|[^0-9])' || code || '([^0-9]|$)')
     and quote !~ ('(^|[^0-9])' || code || '([^0-9]|$)');" \
"$LIVE select '* ' || code || '  ' || state || '  ' || payer
          || '  [' || attribute || ']' || chr(10)
          || '    agency-benefit wording found, no \"home health agency\" scope disclaimer' || chr(10)
          || '    ANSWER: ' || left(ans, 500) || chr(10)
   from live
   where code in ($HOME_EM) and attribute in ('prior_auth_required','covered')
     and hay ~* '$B5_TRIGGER' and hay !~* 'home health agency'
     and quote !~ ('(^|[^0-9])' || code || '([^0-9]|$)')
   order by payer, code limit $MAX_ROWS_SHOWN;" \
record

# --- B6: the LIMIT 1 invariant at a BACK-DATED date of service ----------------
# B1 asks at the audit DOS only.  A denial is re-worked at the DOS on the claim,
# which is months back, and the set of rows served at that DOS is a DIFFERENT
# set.  Two rows live at that DOS on one key is the same nondeterminism B1
# guards against -- and `expiration_date IS NULL` cannot see it at all, because
# it has no notion of a date.
read -r -d '' B6_BODY <<SQL
with back(lbl, dos) as (values
  ('90d back',  ($DOS_SQL - 90)),
  ('180d back', ($DOS_SQL - 180)),
  ('365d back', ($DOS_SQL - 365))),
dup as (
  select b.lbl, b.dos, pr.payer_id, pr.state, pr.code, pr.attribute, count(*) as live_rows
  from back b
  join payer_rule pr
    on pr.effective_date <= b.dos
   and (pr.expiration_date is null or pr.expiration_date > b.dos)
  group by 1,2,3,4,5,6
  having count(*) > 1)
SQL

# Counted as DISTINCT keys, not as (key x date) pairs: a key that is ambiguous
# at both 90d and 180d is ONE broken key, and summing the three dates would
# report it as two or three.
check B6 "LIMIT 1 invariant holds at 90/180/365 days back too" \
"$B6_BODY select count(*) from (select distinct payer_id, state, code, attribute from dup) k;" \
"$B6_BODY
 select coalesce(p.name::text,'(unknown payer)') as payer,
        d.state, d.code, d.attribute,
        max(d.live_rows)                          as worst_live_rows,
        string_agg(distinct d.lbl, ', ')          as ambiguous_at
   from dup d left join payer p on p.id = d.payer_id
  group by payer, d.state, d.code, d.attribute
  order by max(d.live_rows) desc, payer, d.code, d.attribute limit $MAX_ROWS_SHOWN;"

# =============================================================================
printf '\nSECTION D -- DATE OF SERVICE DIMENSION   (context, not a pass/fail)\n'
hr
printf '  Practices re-work denials inside the timely-filing window, so the\n'
printf '  question "what does the library answer?" has a different answer at\n'
printf '  every date of service.  Same predicate as fetchPayerRule, four dates.\n\n'

sql_table "with back(ord, lbl, dos) as (values
  (1,'today',     ($DOS_SQL)),
  (2,'90d back',  ($DOS_SQL - 90)),
  (3,'180d back', ($DOS_SQL - 180)),
  (4,'365d back', ($DOS_SQL - 365))),
served as (
  select b.ord, b.lbl, b.dos, pr.payer_id, pr.state, pr.code, pr.attribute
    from back b
    left join payer_rule pr
      on pr.effective_date <= b.dos
     and (pr.expiration_date is null or pr.expiration_date > b.dos))
select s.lbl as date_of_service, s.dos,
       count(s.payer_id) as rules_served,
       count(distinct (s.payer_id::text||s.state||s.code||s.attribute)) as cells_answered,
       count(s.payer_id)
         - count(distinct (s.payer_id::text||s.state||s.code||s.attribute)) as surplus_rows_on_a_key,
       count(distinct s.payer_id) as payers,
       count(distinct s.code)     as codes
  from served s group by s.ord, s.lbl, s.dos order by s.ord;" | indent 2
printf '        (surplus_rows_on_a_key > 0 means more than one rule is live on\n'
printf '         some key at that date.  fetchPayerRule ends in LIMIT 1 with no\n'
printf '         tiebreak, so which one a biller sees is Postgres row order.\n'
printf '         B6 above fails on exactly this.)\n'

printf '\n  Where the two definitions of "live" disagree, right now\n\n'
sql_table "select
  count(*) filter (where expiration_date is null
                     and not (effective_date <= $DOS_SQL))                       as exp_null_but_not_yet_served,
  count(*) filter (where expiration_date is not null and expiration_date > $DOS_SQL
                     and effective_date <= $DOS_SQL)                             as served_but_exp_null_misses_it,
  count(*) filter (where expiration_date is null)                                as exp_null_total,
  count(*) filter (where effective_date <= $DOS_SQL
                     and (expiration_date is null or expiration_date > $DOS_SQL)) as served_total
from payer_rule;" | indent 2
printf '        (A FUTURE expiration_date is the normal way to schedule an annual\n'
printf '         sunset.  Every such rule IS served in production and the old\n'
printf '         IS NULL test could not see one of them.  If both middle columns\n'
printf '         read 0 the two definitions happen to coincide TODAY -- that is a\n'
printf '         property of the data on this date, not of the test, and it stops\n'
printf '         being true the moment anyone schedules a sunset or back-dates a\n'
printf '         lookup.  The row counts above already differ at every other DOS.)\n'

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
printf '         on the unambiguous single-code substitutions.)\n\n'

# --- F6 visibility: how much of the library is general policy, not code policy
note C3 "Prose names a DIFFERENT code and never its own" \
"$LIVE, m as (
   select l.id, l.code,
     (regexp_matches(l.ans,'(?:^|[^0-9A-Za-z])((?:9[0-9]{4})|(?:[A-HJ-VX-Z][0-9]{4}))(?![0-9A-Za-z])','g'))[1] as mentioned
   from live l)
 select count(*) from (
   select id from m group by id, code
    having count(*) filter (where mentioned <> code) > 0
       and count(*) filter (where mentioned =  code) = 0) z;"

note C4 "Stamped mappedFrom = service-level rule mapped to code" \
"$LIVE select count(*) from live
   where mapped_from = 'service-level rule mapped to this code';"

printf '        (C3/C4 are VISIBILITY, not failure.  Service-level mapping is\n'
printf '         legitimate and deliberate -- a payer publishes one home-visit\n'
printf '         policy, the pipeline stamps it onto each code in that family.\n'
printf '         But the volume is the difference between "we read a policy\n'
printf '         about 99349" and "we read a policy about home visits".  A\n'
printf '         reader of this report is entitled to know which they are\n'
printf '         holding, so the number is on the page.)\n'

printf '\n  Section C in scope: the %s rules served at %s\n' "$TOTAL_LIVE" "$AUDIT_DATE"

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
printf ' Checks that could have failed .... %s\n' "$((PASS_COUNT + FAIL_COUNT))"
printf '   passed ........................ %s\n' "$PASS_COUNT"
printf '   failed ........................ %s\n' "$FAIL_COUNT"
printf ' Structural guarantees restated ... %s   (NOT checks -- the schema forbids\n' "$STRUCT_COUNT"
printf '                                        the failure, so no row was proved\n'
printf '                                        by them.  Excluded from the tally.)\n'
printf ' Rules walked ..................... %s   at DOS %s\n' "$TOTAL_LIVE" "$AUDIT_DATE"

if [ "$FAIL_COUNT" -eq 0 ]; then
  printf '\n ALL %s CHECKS PASSED at DOS %s.  Every one of the %s rules served at\n' \
    "$PASS_COUNT" "$AUDIT_DATE" "$TOTAL_LIVE"
  printf ' that date is sourced, internally consistent, and free of the\n'
  printf ' contradiction classes above.\n'
  printf '\n This is NOT a statement about other dates of service.  Read Section D.\n'
  printf '============================================================================\n\n'
  exit 0
fi

printf '\n FAILURES -- send this list to the rules team:\n\n'
printf "%b" "$FAILED_SUMMARY"
printf '\n Offending rows are printed above, under each failed check.\n'
printf '============================================================================\n\n'
exit "$FAIL_COUNT"
