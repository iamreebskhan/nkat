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

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/pallio-predeploy-$STAMP.dump"

if [ "$SKIP_BACKUP" = "1" ]; then
  info "skipped (--skip-backup)"
elif [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] would dump '$PG_DB' -> $DUMP"
else
  # 0700 / 0600: these dumps contain PHI.
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  # pg_dump writes to STDOUT and THIS (root) shell owns the redirect.
  # Passing -f instead would make the `postgres` user create the file,
  # and it has no write access to a root-owned backup directory —
  # "could not open output file: Permission denied".
  if ! sudo -u postgres pg_dump --format=custom --no-owner --no-privileges \
        -d "$PG_DB" > "$DUMP"; then
    rm -f "$DUMP"
    die "pg_dump failed — nothing has been changed"
  fi
  chmod 600 "$DUMP"

  info "backup: $DUMP ($(du -h "$DUMP" | cut -f1))"
  info "restore: sudo -u postgres pg_restore -d $PG_DB --clean --if-exists '$DUMP'"
  # Keep a fortnight of pre-deploy snapshots.
  find "$BACKUP_DIR" -name 'pallio-predeploy-*.dump' -mtime +14 -delete
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

# npm ci, not install: reproducible, and it fails loudly if the lockfile
# and package.json disagree. Dev deps are required — next build needs
# typescript and the tailwind toolchain.
#
# But npm ci DELETES node_modules before reinstalling, and the live app
# is still serving from it. If the build then failed we would have taken
# production down for a deploy that never shipped. So only reinstall when
# the dependency set actually changed.
if [ ! -d node_modules ]; then
  info "node_modules missing — installing"
  run "npm ci --no-audit --no-fund"
elif [ "$DRY_RUN" = "1" ]; then
  if git diff --quiet "$PREV_SHA" HEAD -- package.json package-lock.json 2>/dev/null; then
    info "[dry-run] deps unchanged since $PREV_SHA — would skip npm ci"
  else
    info "[dry-run] deps changed — would run npm ci"
  fi
elif git diff --quiet "$PREV_SHA" HEAD -- package.json package-lock.json 2>/dev/null; then
  info "deps unchanged since ${PREV_SHA:0:7} — skipping npm ci"
else
  info "package.json/lock changed — reinstalling"
  npm ci --no-audit --no-fund
fi

# ---------------------------------------------------------------------
say "5/7  Migrations"

# Everything at or below the baseline counts as already applied. This
# database was migrated by hand up to MIGRATION_BASELINE, so replaying
# 0001.. would be destructive.
baseline_set() {
  for f in db/migrations/*.sql; do
    base="$(basename "$f")"
    num="${base%%_*}"
    if [ "$num" \< "$MIGRATION_BASELINE" ] || [ "$num" = "$MIGRATION_BASELINE" ]; then
      echo "$base"
    fi
  done
}

if [ "$DRY_RUN" != "1" ]; then
  psql_db <<SQL
CREATE TABLE IF NOT EXISTS schema_migration (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
  if [ "$(psql_db -tAc 'SELECT count(*) FROM schema_migration')" = "0" ]; then
    info "ledger empty — back-filling migrations <= $MIGRATION_BASELINE as applied"
    baseline_set | while read -r base; do
      psql_db -c "INSERT INTO schema_migration (filename) VALUES ('$base') ON CONFLICT DO NOTHING" >/dev/null
    done
    info "back-filled $(psql_db -tAc 'SELECT count(*) FROM schema_migration') entries"
  fi
fi

# Read the applied set ONCE (not one psql per file), and — crucially —
# when the ledger does not exist yet, PREDICT what the back-fill above
# will insert. Without that prediction a --dry-run before the first real
# run reports all 65 migrations as pending, which reads like the script
# is about to replay the whole schema from 0001. It is not, but a dry run
# nobody can trust is worse than no dry run at all.
LEDGER_EXISTS="$(sudo -u postgres psql -X -tAq -d "$PG_DB" \
  -c "SELECT to_regclass('public.schema_migration') IS NOT NULL" 2>/dev/null \
  | tr -d '[:space:]')"

if [ "$LEDGER_EXISTS" = "t" ]; then
  APPLIED="$(sudo -u postgres psql -X -tAq -d "$PG_DB" \
    -c 'SELECT filename FROM schema_migration' 2>/dev/null)"
else
  APPLIED="$(baseline_set)"
  info "ledger not created yet — predicting back-fill <= $MIGRATION_BASELINE"
fi

PENDING=""
for f in db/migrations/*.sql; do
  base="$(basename "$f")"
  if ! printf '%s\n' "$APPLIED" | grep -qxF "$base"; then
    PENDING="$PENDING $base"
  fi
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
