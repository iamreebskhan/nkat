#!/usr/bin/env bash
# =============================================================================
#  drift-cron.sh — weekly wrapper around scripts/recheck-source-drift.mjs
#
#  Cron mails whatever a job prints. So this prints NOTHING when every cited
#  document still says what its rules claim, and prints a short report when it
#  does not. A weekly job that always emails is a weekly job people filter into
#  a folder and stop reading.
#
#  It only ever reports. Nothing is expired, edited or deleted — the drift
#  checker does not touch the library, and neither does this.
#
#  WHAT COUNTS AS WORTH AN EMAIL
#    DRIFTED       yes — a document no longer contains a quote a rule cites
#    SUSPECT       yes, but flagged as probably-not-the-same-document
#    unreachable   NO by default — payer sites 403 and time out constantly,
#                  and a weekly mail about Molina blocking us is noise. Set
#                  ALERT_UNREACHABLE=1 to include it.
#    unreadable    no — a format we cannot parse is our limitation, not a change
#    degraded      yes — a document we could verify last week and cannot now
#    mirror host   only when it does NOT clear. One dead archive degrades every
#                  document that falls back to it in the same run; those payers
#                  did not change anything and their origins were already
#                  failing, so the first run is noted and stays silent. A route
#                  still dead on the next run is one that has to be replaced.
#
#  INSTALL (as root on the VPS)
#    crontab -e   and add:
#      17 6 * * 1  /bin/bash /opt/pallio/app/scripts/drift-cron.sh
#
#    Monday 06:17. The odd minute is deliberate: payer sites see a lot of
#    traffic on the hour, and we fetch ~57 documents.
#
#    INVOKE IT THROUGH bash, and do NOT chmod +x this file. Every script in
#    this repo is committed non-executable and run as `bash scripts/x.sh` —
#    deploy.sh included. Setting the bit on the server makes git see a
#    permanent mode change (100644 -> 100755), and deploy.sh refuses to run
#    against a dirty working tree, so one chmod blocks every future deploy.
#    That is not hypothetical; it is why this paragraph exists.
#
#  Reports are kept in /var/log/pallio/ so a drift can be compared against the
#  previous week rather than argued about from memory.
# =============================================================================

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/pallio/app}"
LOG_DIR="${LOG_DIR:-/var/log/pallio}"
KEEP_REPORTS="${KEEP_REPORTS:-12}"     # ~3 months of weekly runs
ALERT_UNREACHABLE="${ALERT_UNREACHABLE:-0}"

# cron runs with a near-empty PATH; node and psql must be found explicitly.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

STAMP="$(date -u '+%Y-%m-%d')"
mkdir -p "$LOG_DIR" || { echo "drift-cron: cannot create $LOG_DIR"; exit 2; }
LOG="$LOG_DIR/drift-$STAMP.log"
JSON="$LOG_DIR/drift-$STAMP.json"

cd "$APP_DIR" || { echo "drift-cron: $APP_DIR not found"; exit 2; }

command -v node >/dev/null 2>&1 || { echo "drift-cron: node not on PATH"; exit 2; }
if ! command -v pdftotext >/dev/null 2>&1; then
  echo "drift-cron: pdftotext missing — every PDF will report 'unreadable'."
  echo "            install it:  apt-get install -y poppler-utils"
fi

# The newest report from a previous run, found BEFORE this run writes its own.
# Without it the job can only see today: it would report nine documents as
# unverifiable every week and never mention that one of them was verifiable
# last week. A document sliding from ok to blocked is the library losing the
# ability to check rules it could check before, and nobody would be told.
PREV="$(ls -1t "$LOG_DIR"/drift-*.json 2>/dev/null | head -1)"

# Under cron there is no terminal, everything goes to the log, and the job is
# meant to be silent. Run by hand it behaved identically — six minutes of no
# output at all while it fetches ~58 documents, several of which sit on origins
# that take a full 60s to time out. That is indistinguishable from a hang, and
# the natural response is to kill it, which is exactly what happened. When
# there IS a terminal, mirror the run to it as well as to the log.
#
# The mail path does not change: every decision below reads "$LOG", which is
# written in both cases. tee is only a second destination, never the source.
if [ -t 1 ]; then
  echo "drift-cron: checking ~58 documents, this takes several minutes." >&2
  echo "drift-cron: log -> $LOG" >&2
  echo >&2
  run_check() { "$@" 2>&1 | tee "$LOG"; return "${PIPESTATUS[0]}"; }
else
  run_check() { "$@" > "$LOG" 2>&1; }
fi

if [ -n "$PREV" ]; then
  run_check node scripts/recheck-source-drift.mjs --json "$JSON" --since "$PREV"
else
  run_check node scripts/recheck-source-drift.mjs --json "$JSON"
fi
RC=$?

# Prune old reports, newest kept.
ls -1t "$LOG_DIR"/drift-*.log  2>/dev/null | tail -n +$((KEEP_REPORTS + 1)) | xargs -r rm -f
ls -1t "$LOG_DIR"/drift-*.json 2>/dev/null | tail -n +$((KEEP_REPORTS + 1)) | xargs -r rm -f

# Exit 2 is the checker's "could not run at all" — always worth an email.
if [ "$RC" -eq 2 ]; then
  echo "SOURCE DRIFT CHECK COULD NOT RUN (exit 2). Full log: $LOG"
  tail -n 20 "$LOG"
  exit 2
fi

summary() { grep -E "^ (ok|DRIFTED|SUSPECT|unreadable|blocked|oversized|unreachable) \.+" "$LOG"; }
n_drift="$(grep -cE '^  DRIFTED ' "$LOG" || true)"
n_susp="$(grep -cE '^  SUSPECT ' "$LOG" || true)"
n_unreach="$(grep -cE '^  unreachable' "$LOG" || true)"

# A document that got HARDER to verify since last week. Always worth an email,
# even with ALERT_UNREACHABLE off: the steady-state list of blocked documents
# is noise, but a NEW one is a payer that just started refusing us.
n_degraded="$(grep -cE '^ DEGRADED SINCE ' "$LOG" || true)"

# A shared fallback host that stopped answering is a DIFFERENT event, and
# lumping it in with the line above is what made this job cry wolf. When the
# Internet Archive goes down, every document that leans on it degrades in the
# same run — nine at once, on a morning when nothing about any payer changed
# and their own origins were already failing anyway. That is one third-party
# outage, it is not actionable, and it is usually over before anyone reads the
# mail. So it stays quiet on the first run and speaks when it does NOT clear,
# because an archive route that is still dead a week later is a route that has
# to be replaced. Real drift is untouched by this: DRIFTED and SUSPECT always
# mail, on the first run, every run.
n_mirror_new="$(grep -cE '^ MIRROR HOST UNAVAILABLE \(first run\)' "$LOG" || true)"
n_mirror_stuck="$(grep -cE '^ MIRROR HOST UNAVAILABLE \(persistent\)' "$LOG" || true)"

speak=0
[ "${n_drift:-0}" -gt 0 ] && speak=1
[ "${n_susp:-0}" -gt 0 ] && speak=1
[ "${n_degraded:-0}" -gt 0 ] && speak=1
[ "${n_mirror_stuck:-0}" -gt 0 ] && speak=1
[ "$ALERT_UNREACHABLE" = "1" ] && [ "${n_unreach:-0}" -gt 0 ] && speak=1

if [ "$speak" = "0" ]; then
  exit 0   # silence: every cited document still supports its rules
fi

echo "Pallio source-drift check — $STAMP"
echo
summary
echo
echo "A drifted document means the payer changed or replaced the page a rule"
echo "cites. The rule is not necessarily wrong, but its citation no longer"
echo "proves it, and a biller clicking through gets something else. Nothing was"
echo "expired; re-extract from the current document or retire the rule."
echo
echo "Documents needing attention:"
grep -E "^  (DRIFTED|SUSPECT) " -A 1 "$LOG" | grep -vE "^--$" | sed 's/^/  /'
echo

# Printed whether or not anything drifted: a document that stopped being
# readable is the other way this library decays, and it is the half that used
# to go unreported.
if [ "${n_degraded:-0}" -gt 0 ]; then
  echo "Got harder to verify since the last run:"
  awk '/^ DEGRADED SINCE /{f=1} /^ MIRROR HOST UNAVAILABLE /{f=0} /^={10,}$/{f=0} f' "$LOG" | sed 's/^/  /'
  echo
  echo "A document sliding to blocked, unreachable or oversized does not mean the"
  echo "payer changed anything. It means we can no longer prove they did not."
  echo
fi

# Printed whenever present — including on a first run, which does not by itself
# earn the email. If something else in this report already broke the silence,
# the reader should see this too rather than wonder why a count moved.
if [ "${n_mirror_new:-0}" -gt 0 ] || [ "${n_mirror_stuck:-0}" -gt 0 ]; then
  echo "A shared fallback host did not answer:"
  awk '/^ MIRROR HOST UNAVAILABLE /{f=1} /^={10,}$/{f=0} f' "$LOG" | sed 's/^/  /'
  echo
fi
echo "Full log:    $LOG"
echo "Machine-readable: $JSON"
exit 0   # a finding is not a failure of the JOB; do not let cron retry-spam
