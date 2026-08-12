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

node scripts/recheck-source-drift.mjs --json "$JSON" > "$LOG" 2>&1
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

summary() { grep -E "^ (ok|DRIFTED|SUSPECT|unreadable|unreachable) \.+" "$LOG"; }
n_drift="$(grep -cE '^  DRIFTED ' "$LOG" || true)"
n_susp="$(grep -cE '^  SUSPECT ' "$LOG" || true)"
n_unreach="$(grep -cE '^  unreachable' "$LOG" || true)"

speak=0
[ "${n_drift:-0}" -gt 0 ] && speak=1
[ "${n_susp:-0}" -gt 0 ] && speak=1
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
echo "Full log:    $LOG"
echo "Machine-readable: $JSON"
exit 0   # a finding is not a failure of the JOB; do not let cron retry-spam
