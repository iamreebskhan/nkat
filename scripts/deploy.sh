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
#   6. Apply CHANGED seeds from db/seed/MANIFEST, tracked by content hash,
#      then assert the rule library still has one live rule per key
#   7. npm run build
#   8. pm2 reload + health check, with the rollback command printed
#
# Both ledgers are created on first run and back-filled, so nothing that
# was already applied by hand gets replayed over live data: migrations up
# to MIGRATION_BASELINE (this database was migrated by hand to 0063), and
# every seed currently checked in.
#
# Seeds are keyed on CONTENT, not name — edit a seed and the next deploy
# re-applies it. They are all idempotent (deterministic ids + ON CONFLICT
# DO UPDATE), which is what makes that safe. A seed missing from the
# manifest is never applied; that is how the test fixtures stay out.
#
# After this, every future deploy is just: sudo bash scripts/deploy.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pallio/app}"
PG_DB="${PG_DB:-pallio}"
PM2_APP="${PM2_APP:-pallio}"
BASE_URL="${BASE_URL:-https://app.pallio.io}"
APP_PORT="${APP_PORT:-3000}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:$APP_PORT}"
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
    -h|--help)      sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say()  { echo ""; echo "==> $*"; }
info() { echo "    $*"; }
die()  { echo "FATAL: $*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = "1" ]; then echo "    [dry-run] $*"; else eval "$@"; fi; }

psql_db() { sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$PG_DB" "$@"; }

# ---------------------------------------------------------------------
say "1/8  Preconditions"

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
say "2/8  Database backup"

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
say "3/8  Fetch + checkout"

run "git fetch origin --prune --tags"
run "git checkout '$REF'"
# Only fast-forward a branch; a detached tag/SHA has no upstream to pull.
if [ "$DRY_RUN" != "1" ] && git symbolic-ref -q HEAD >/dev/null; then
  git pull --ff-only origin "$REF"
fi
[ "$DRY_RUN" != "1" ] && info "now at: $(git rev-parse HEAD)  $(git log -1 --pretty=%s)"

# ---------------------------------------------------------------------
say "4/8  Dependencies"

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
say "5/8  Migrations"

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
say "6/8  Seeds"

# Reference data and the rule library live in db/seed/, and until now the
# deploy never touched them — every rule seed reached production by hand.
# That is how a database ends up quietly missing a seed nobody remembers
# skipping, which has already happened once.
#
# Applied by CONTENT HASH, not just by name: these files are idempotent
# (deterministic ids + ON CONFLICT DO UPDATE), so re-applying an edited
# seed is both safe and the point — a corrected rule reaches production
# on the next deploy instead of needing a hand-run.
#
# Order comes from db/seed/MANIFEST. Files absent from the manifest are
# never applied, which is what keeps the test fixtures out.
SEED_MANIFEST="db/seed/MANIFEST"

if [ ! -f "$SEED_MANIFEST" ]; then
  info "no $SEED_MANIFEST — skipping seeds"
else
  seed_list() {
    sed 's/#.*//' "$SEED_MANIFEST" | while read -r line; do
      [ -n "$line" ] && echo "$line"
    done
  }

  # NO BASELINE BACK-FILL HERE, unlike migrations, and the difference is
  # deliberate. Migrations are forward-only and destructive to replay, so
  # the ones already applied by hand must be marked applied. Seeds are the
  # opposite: idempotent by construction, and applied in an order the
  # manifest fixes, so replaying the whole set converges on the correct
  # end state no matter what the database currently holds.
  #
  # That matters because nobody knows exactly which seeds this database
  # received by hand — and a back-fill would have to guess. Guessing wrong
  # in the safe-looking direction marks an unapplied seed as applied and
  # the rules never arrive, which is the failure this step exists to end.
  # So the first run applies everything, behind the pre-deploy backup and
  # the invariant check below.
  if [ "$DRY_RUN" != "1" ]; then
    psql_db <<SQL
CREATE TABLE IF NOT EXISTS seed_application (
  filename       TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
  fi

  SEED_LEDGER_EXISTS="$(sudo -u postgres psql -X -tAq -d "$PG_DB" \
    -c "SELECT to_regclass('public.seed_application') IS NOT NULL" 2>/dev/null \
    | tr -d '[:space:]')"
  [ "$SEED_LEDGER_EXISTS" = "t" ] || info "first run — the full manifest will be applied (all seeds are idempotent)"

  SEED_PENDING=""
  MISSING_SEEDS=""
  for base in $(seed_list); do
    if [ ! -f "db/seed/$base" ]; then
      MISSING_SEEDS="$MISSING_SEEDS $base"
      continue
    fi
    have="$(sha256sum "db/seed/$base" | cut -d' ' -f1)"
    if [ "$SEED_LEDGER_EXISTS" = "t" ]; then
      recorded="$(sudo -u postgres psql -X -tAq -d "$PG_DB" \
        -c "SELECT content_sha256 FROM seed_application WHERE filename = '$base'" 2>/dev/null \
        | tr -d '[:space:]')"
    else
      recorded=""
    fi
    [ "$recorded" = "$have" ] || SEED_PENDING="$SEED_PENDING $base"
  done

  # A manifest naming a file that does not exist is a mistake worth
  # shouting about — silently skipping it is how a seed goes missing.
  [ -n "$MISSING_SEEDS" ] && die "MANIFEST lists files not in db/seed/:$MISSING_SEEDS"

  # Seeds carry reference data and the global rule library. Nothing that
  # writes a tenant table belongs in them: one such seed created an org
  # called 'Design Partner Co' with a fake Stripe subscription, and it was
  # caught by accident. This catches the next one on purpose.
  TENANT_WRITERS=""
  for base in $(seed_list); do
    if grep -qiE 'INSERT INTO (org|app_user|subscription|patient|visit|superbill|org_rulebook_row|org_membership)[[:space:](]' "db/seed/$base" 2>/dev/null; then
      TENANT_WRITERS="$TENANT_WRITERS $base"
    fi
  done
  [ -n "$TENANT_WRITERS" ] && die "these manifest seeds write TENANT tables and must not run against production:$TENANT_WRITERS"

  if [ -z "$SEED_PENDING" ]; then
    info "no pending seeds"
  else
    for base in $SEED_PENDING; do
      info "applying seed $base"
      if [ "$DRY_RUN" = "1" ]; then
        echo "    [dry-run] would apply db/seed/$base"
      else
        sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$PG_DB" -f "db/seed/$base" \
          || die "seed $base FAILED — that file rolled back; app not restarted. Restore: sudo -u postgres pg_restore -d $PG_DB --clean --if-exists '${DUMP:-<backup>}'"
        h="$(sha256sum "db/seed/$base" | cut -d' ' -f1)"
        psql_db -c "INSERT INTO seed_application (filename, content_sha256) VALUES ('$base', '$h')
                    ON CONFLICT (filename) DO UPDATE SET content_sha256 = EXCLUDED.content_sha256, applied_at = now()"
      fi
    done
  fi

  # The library's core invariant: fetchPayerRule ends in LIMIT 1 with no
  # confidence tiebreak, so two live rows on one key make the answer
  # depend on row order. Check it here, where a bad seed is still one
  # restore away from undone.
  if [ "$DRY_RUN" != "1" ]; then
    DUPES="$(psql_db -tAc "SELECT count(*) FROM (SELECT payer_id, state, code, attribute FROM payer_rule WHERE expiration_date IS NULL GROUP BY 1,2,3,4 HAVING count(*) > 1) d" | tr -d '[:space:]')"
    if [ "$DUPES" != "0" ]; then
      die "$DUPES (payer, state, code, attribute) keys have MORE THAN ONE live rule. A seed failed to supersede what it replaced, and lookups on those keys now return whichever row comes back first. Restore: sudo -u postgres pg_restore -d $PG_DB --clean --if-exists '${DUMP:-<backup>}'"
    fi
    info "rule-library invariant OK — one live rule per key"
  fi
fi

# ---------------------------------------------------------------------
say "7/8  Build"

if [ "$SKIP_BUILD" = "1" ]; then
  info "skipped (--skip-build)"
else
  run "npm run build"
fi

# ---------------------------------------------------------------------
say "8/8  Restart + health check"

run "pm2 reload '$PM2_APP' --update-env"

if [ "$DRY_RUN" != "1" ]; then
  # Check the LOCAL app port, not the public URL. Curling our own public
  # domain from this box needs NAT hairpin, which this VPS does not do —
  # it returns 000 even when the site is perfectly healthy externally.
  # The local port is also the thing we actually want to assert: that
  # pm2 brought the Next.js process back up.
  # --retry-connrefused rides out the reload window without a sleep.
  code="$(curl -s -o /dev/null -w '%{http_code}' \
          --retry 30 --retry-delay 2 --retry-connrefused --retry-all-errors \
          --max-time 180 "$LOCAL_URL/login" || echo 000)"
  if [ "$code" = "200" ]; then
    info "health check OK — $LOCAL_URL/login returned 200"
  else
    echo ""
    echo "HEALTH CHECK FAILED: $LOCAL_URL/login returned $code"
    echo "  logs:     pm2 logs $PM2_APP --lines 80"
    echo "  rollback: cd $APP_DIR && git checkout $PREV_SHA && npm ci && npm run build && pm2 reload $PM2_APP"
    exit 1
  fi

  # Public edge (Nginx + TLS) is informational only — see the hairpin
  # note above. A failure here does NOT mean the site is down.
  edge="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE_URL/login" || echo 000)"
  if [ "$edge" = "200" ]; then
    info "public edge OK — $BASE_URL/login returned 200"
  else
    info "public edge returned $edge from this host (expected: no NAT hairpin). Verify externally."
  fi
fi

echo ""
echo "==> Deployed $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
echo "    rollback if needed:"
echo "      cd $APP_DIR && git checkout $PREV_SHA && npm ci && npm run build && pm2 reload $PM2_APP"
echo "    note: migrations are forward-only — roll the app back, then write a fixup migration."
