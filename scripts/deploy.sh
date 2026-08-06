#!/usr/bin/env bash
# deploy.sh — one-command production deploy for the Pallio VPS.
#
# Run on the VPS:
#   sudo bash /opt/pallio/app/scripts/deploy.sh
#
# Options:
#   --ref <git-ref>    branch/tag/SHA to deploy      (default: main)
#   --dry-run          show what WOULD happen, change nothing
#   --skip-backup      skip the pre-migration pg_dump (not advised)
#   --skip-build       DB migrations + restart only, no rebuild
#
# What it does, in order, stopping on the first failure:
#   1. Preconditions — root, app dir, clean tree, pm2 process present
#   2. pg_dump the database to /var/backups/pallio (kept 14 days)
#   3. git fetch + checkout the ref
#   4. npm ci
#   5. Apply PENDING migrations only, tracked in a schema_migration ledger
#   6. npm run build
#   7. pm2 reload + health check, with the rollback command printed
#
# The ledger is created on first run and back-filled so that everything
# up to MIGRATION_BASELINE is treated as already applied — this database
# was migrated by hand up to 0063, so nothing before that is re-run.
# After this, every future deploy is just: sudo bash scripts/deploy.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pallio/app}"
PG_DB="${PG_DB:-pallio}"
PM2_APP="${PM2_APP:-pallio}"
BASE_URL="${BASE_URL:-https://app.pallio.io}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pallio}"
MIGRATION_BASELINE="${MIGRATION_BASELINE:-0063}"
REF="main"
DRY_RUN=0
SKIP_BACKUP=0
SKIP_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)          REF="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --skip-backup)  SKIP_BACKUP=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    -h|--help)      sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say()  { echo ""; echo "==> $*"; }
info() { echo "    $*"; }
die()  { echo "FATAL: $*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = "1" ]; then echo "    [dry-run] $*"; else eval "$@"; fi; }

psql_db() { sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$PG_DB" "$@"; }

# ---------------------------------------------------------------------
say "1/7  Preconditions"

[ "$(id -u)" = "0" ] || die "run with sudo (needs postgres + pm2 + /var/backups)"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout"
cd "$APP_DIR"

# Uncommitted edits on the server are almost always an accident, and a
# checkout would silently discard them.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is dirty — commit, stash or discard on the server first"
fi

command -v pg_dump >/dev/null || die "pg_dump not found"
command -v pm2     >/dev/null || die "pm2 not found"
pm2 describe "$PM2_APP" >/dev/null 2>&1 || die "no pm2 process named '$PM2_APP'"

PREV_SHA="$(git rev-parse HEAD)"
info "current commit : $PREV_SHA"
info "deploying ref  : $REF"
[ "$DRY_RUN" = "1" ] && info "DRY RUN — nothing will change"

# ---------------------------------------------------------------------
say "2/7  Database backup"

if [ "$SKIP_BACKUP" = "1" ]; then
  info "skipped (--skip-backup)"
else
  run "mkdir -p '$BACKUP_DIR'"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  DUMP="$BACKUP_DIR/pallio-predeploy-$STAMP.dump"
  run "sudo -u postgres pg_dump --format=custom --no-owner --no-privileges -d '$PG_DB' -f '$DUMP'"
  run "chmod 600 '$DUMP'"
  if [ "$DRY_RUN" != "1" ]; then
    info "backup: $DUMP ($(du -h "$DUMP" | cut -f1))"
    info "restore with: sudo -u postgres pg_restore -d $PG_DB --clean --if-exists '$DUMP'"
  fi
  # Keep a fortnight of pre-deploy snapshots.
  run "find '$BACKUP_DIR' -name 'pallio-predeploy-*.dump' -mtime +14 -delete"
fi

# ---------------------------------------------------------------------
say "3/7  Fetch + checkout"

run "git fetch origin --prune --tags"
run "git checkout '$REF'"
# Only fast-forward a branch; a detached tag/SHA has no upstream to pull.
if [ "$DRY_RUN" != "1" ] && git symbolic-ref -q HEAD >/dev/null; then
  git pull --ff-only origin "$REF"
fi
[ "$DRY_RUN" != "1" ] && info "now at: $(git rev-parse HEAD)  $(git log -1 --pretty=%s)"

# ---------------------------------------------------------------------
say "4/7  Dependencies"

# npm ci, not install: reproducible and it fails loudly if the lockfile
# and package.json disagree. Dev deps are required — next build needs
# typescript and the tailwind toolchain.
run "npm ci --no-audit --no-fund"

# ---------------------------------------------------------------------
say "5/7  Migrations"

if [ "$DRY_RUN" != "1" ]; then
  psql_db <<SQL
CREATE TABLE IF NOT EXISTS schema_migration (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
fi

# First run: treat everything at or below the baseline as already applied.
if [ "$DRY_RUN" != "1" ]; then
  LEDGER_ROWS="$(psql_db -tAc "SELECT count(*) FROM schema_migration")"
  if [ "$LEDGER_ROWS" = "0" ]; then
    info "ledger empty — back-filling migrations <= $MIGRATION_BASELINE as applied"
    for f in db/migrations/*.sql; do
      base="$(basename "$f")"
      num="${base%%_*}"
      if [ "$num" \< "$MIGRATION_BASELINE" ] || [ "$num" = "$MIGRATION_BASELINE" ]; then
        psql_db -c "INSERT INTO schema_migration (filename) VALUES ('$base') ON CONFLICT DO NOTHING"
      fi
    done
    info "back-filled $(psql_db -tAc 'SELECT count(*) FROM schema_migration') entries"
  fi
fi

PENDING=""
for f in db/migrations/*.sql; do
  base="$(basename "$f")"
  if [ "$DRY_RUN" = "1" ]; then
    applied="$(sudo -u postgres psql -X -tAq -d "$PG_DB" \
      -c "SELECT 1 FROM schema_migration WHERE filename='$base'" 2>/dev/null || echo "")"
  else
    applied="$(psql_db -tAc "SELECT 1 FROM schema_migration WHERE filename='$base'")"
  fi
  [ -z "$applied" ] && PENDING="$PENDING $base"
done

if [ -z "$PENDING" ]; then
  info "no pending migrations"
else
  for base in $PENDING; do
    info "applying $base"
    if [ "$DRY_RUN" = "1" ]; then
      echo "    [dry-run] would apply db/migrations/$base"
    else
      # Each file carries its own BEGIN/COMMIT. ON_ERROR_STOP makes psql
      # abort the deploy rather than continue past a failed statement.
      sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$PG_DB" -f "db/migrations/$base" \
        || die "migration $base FAILED — database rolled back that file; app not restarted. Restore: sudo -u postgres pg_restore -d $PG_DB --clean --if-exists '${DUMP:-<backup>}'"
      psql_db -c "INSERT INTO schema_migration (filename) VALUES ('$base') ON CONFLICT DO NOTHING"
    fi
  done
fi

# ---------------------------------------------------------------------
say "6/7  Build"

if [ "$SKIP_BUILD" = "1" ]; then
  info "skipped (--skip-build)"
else
  run "npm run build"
fi

# ---------------------------------------------------------------------
say "7/7  Restart + health check"

run "pm2 reload '$PM2_APP' --update-env"

if [ "$DRY_RUN" != "1" ]; then
  # --retry-connrefused rides out the reload window without a sleep.
  code="$(curl -s -o /dev/null -w '%{http_code}' \
          --retry 30 --retry-delay 2 --retry-connrefused \
          --max-time 180 "$BASE_URL/login" || echo 000)"
  if [ "$code" = "200" ]; then
    info "health check OK — $BASE_URL/login returned 200"
  else
    echo ""
    echo "HEALTH CHECK FAILED: $BASE_URL/login returned $code"
    echo "  logs:     pm2 logs $PM2_APP --lines 80"
    echo "  rollback: cd $APP_DIR && git checkout $PREV_SHA && npm ci && npm run build && pm2 reload $PM2_APP"
    exit 1
  fi
fi

echo ""
echo "==> Deployed $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
echo "    rollback if needed:"
echo "      cd $APP_DIR && git checkout $PREV_SHA && npm ci && npm run build && pm2 reload $PM2_APP"
echo "    note: migrations are forward-only — roll the app back, then write a fixup migration."
