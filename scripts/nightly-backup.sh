#!/usr/bin/env bash
# Nightly logical backup — runs from the deploy host's cron.
#
# Source: pallio_complete_vision_v3 §12 (DR baseline).
#
# Output:
#   pg_dump -Fc (custom format, compressed) → s3://$BACKUP_BUCKET/pallio-pg/YYYY-MM-DD.dump
#   Object Lock retention: 35 days (rolling weekly verify-restores keep us honest).
#
# Exit codes:
#   0 success
#   1 dump failed
#   2 upload failed
#   3 verify failed
#
# Required env:
#   DATABASE_URL       postgres://… (read-only role preferred)
#   BACKUP_BUCKET      e.g. pallio-prod-backups
#   AWS_REGION
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#
# Required tools: pg_dump (matched to server major), aws, gpg (optional encryption).

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET must be set}"

DATE="$(date -u +%Y-%m-%d)"
HOUR="$(date -u +%H%M)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DUMP="$TMP/pallio-${DATE}-${HOUR}.dump"

echo "[$(date -u +%FT%TZ)] dumping → $DUMP"
if ! pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"; then
  echo "FATAL: pg_dump failed" >&2
  exit 1
fi

SIZE="$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")"
echo "[$(date -u +%FT%TZ)] dump size: $SIZE bytes"

if [ "$SIZE" -lt 1024 ]; then
  echo "FATAL: dump suspiciously small (<1 KiB), aborting upload" >&2
  exit 1
fi

# Optional: encrypt with the prod backup key before upload. Always use
# in production; safe to skip in staging if BACKUP_GPG_RECIPIENT is unset.
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  echo "[$(date -u +%FT%TZ)] encrypting → ${DUMP}.gpg"
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" \
      --output "${DUMP}.gpg" --encrypt "$DUMP"
  rm "$DUMP"
  DUMP="${DUMP}.gpg"
fi

KEY="pallio-pg/${DATE}/$(basename "$DUMP")"
echo "[$(date -u +%FT%TZ)] uploading → s3://$BACKUP_BUCKET/$KEY"
if ! aws s3 cp "$DUMP" "s3://$BACKUP_BUCKET/$KEY" --only-show-errors; then
  echo "FATAL: s3 upload failed" >&2
  exit 2
fi

# Verify by listing it back.
if ! aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$KEY" >/dev/null; then
  echo "FATAL: head-object verify failed" >&2
  exit 3
fi

echo "[$(date -u +%FT%TZ)] backup ok: s3://$BACKUP_BUCKET/$KEY"
