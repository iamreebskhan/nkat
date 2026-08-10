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

# ---------------------------------------------------------------------
# Run from a private copy of ourselves.
#
# Step 3 checks out a new revision, and that REPLACES this file on disk
# while bash is still reading it. Bash reads a script incrementally by
# byte offset, so when the new version is a different length, execution
# resumes at the old offset inside different text — mid-token, mid-block,
# anywhere. The result is a syntax error at best and a half-executed
# deploy at worst, and it gets more likely the more the script grows.
#
# Copying to a temp file first makes the running program immune to the
# checkout. The copy is deleted on exit.
if [ "${DEPLOY_SELF_COPY:-}" != "1" ]; then
  _self="$(mktemp -t deploy.XXXXXX.sh)"
  cat "$0" > "$_self"
  DEPLOY_SELF_COPY=1 DEPLOY_SELF_PATH="$_self" exec bash "$_self" "$@"
fi
# We are the copy. Remove it on exit — but only ever the copy, never the
# script in the repo, hence the explicit path rather than "$0".
[ -n "${DEPLOY_SELF_PATH:-}" ] && trap 'rm -f "$DEPLOY_SELF_PATH"' EXIT

APP_DIR="${APP_DIR:-/opt/pallio/app}"
PG_DB="${PG_DB:-pallio}"
PM2_APP="${PM2_APP:-pallio}"
BASE_URL="${BASE_URL:-https://app.pallio.io}"
# Do NOT hardcode the port. This defaulted to 3000 while the app has been
# serving on 3020, so the health check curled a closed port, got 000, and
# reported a completely successful deploy as a failure — after migrating
# the database, seeding it and rebuilding. A deploy that cries wolf is
# worse than one with no health check, because the next real failure gets
# waved through.
#
# Resolved later, after the reload, from what the process is ACTUALLY
# listening on. See detect_app_port().
APP_PORT="${APP_PORT:-}"
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

# Find the port the app is really on, in decreasing order of authority:
#   1. APP_PORT, if the operator set it explicitly
#   2. the port the running pm2 process is listening on, via its PID —
#      the only source that cannot be out of date
#   3. PORT= in the env files Next actually loads
#   4. 3000, the framework default, as a last resort
detect_app_port() {
  if [ -n "${APP_PORT:-}" ]; then echo "$APP_PORT"; return; fi

  local pid port
  pid="$(pm2 pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$pid" ] && [ "$pid" != "0" ] && command -v ss >/dev/null 2>&1; then
    # Field 4 of `ss -ltnpH` is the local address, e.g. 0.0.0.0:3020,
    # [::]:3020 or *:3020. Take whatever follows the LAST colon, which is
    # the port in all three shapes.
    port="$(ss -ltnpH 2>/dev/null | grep "pid=$pid," \
            | awk '{ n = split($4, a, ":"); print a[n] }' | head -1)"
    if [ -n "$port" ]; then echo "$port"; return; fi
  fi

  for f in "$APP_DIR/.env.production" "$APP_DIR/.env" "$APP_DIR/.env.local"; do
    [ -f "$f" ] || continue
    port="$(grep -E '^PORT=' "$f" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'"'"' ')"
    if [ -n "$port" ]; then echo "$port"; return; fi
  done

  echo 3000
}

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

# Fetch for real even in a dry run. It only moves remote-tracking refs —
# nothing in the working tree changes — and without it a dry run has no
# idea what is actually coming, which is worse than useless: it reports
# the CURRENT checkout's plan while looking like a preview of the deploy.
# That is how a dry run once showed "no pending migrations" for a revision
# carrying three of them.
# (DRY_RUN is "0" or "1" — both non-empty — so ${DRY_RUN:+--quiet} would
#  always be quiet. Test the value.)
if [ "$DRY_RUN" = "1" ]; then
  git fetch origin --prune --tags --quiet
else
  git fetch origin --prune --tags
fi

if [ "$DRY_RUN" = "1" ]; then
  TARGET="$(git rev-parse --verify "origin/$REF" 2>/dev/null || git rev-parse --verify "$REF")"
  info "[dry-run] would check out $REF ($(git log -1 --pretty=%s "$TARGET" 2>/dev/null))"
  if [ "$(git rev-parse HEAD)" = "$TARGET" ]; then
    info "already at that revision — nothing would arrive"
  else
    info "arriving in this deploy ($(git rev-list --count HEAD.."$TARGET") commit(s)):"
    NEW_MIG="$(git diff --name-only --diff-filter=A HEAD "$TARGET" -- db/migrations | sed 's|.*/||')"
    CHG_SEED="$(git diff --name-only HEAD "$TARGET" -- db/seed | sed 's|.*/||')"
    [ -n "$NEW_MIG" ]  && { info "  migrations:"; printf '      %s\n' $NEW_MIG; } || info "  migrations: none"
    [ -n "$CHG_SEED" ] && { info "  seeds (new or edited, so they re-apply):"; printf '      %s\n' $CHG_SEED; } || info "  seeds: none changed"
    if ! git diff --quiet HEAD "$TARGET" -- scripts/deploy.sh; then
      info "  NOTE: deploy.sh itself changed. The real run checks out first and"
      info "        then hands over to the new version, so the steps it performs"
      info "        may differ from the ones listed below."
    fi
  fi
else
  git checkout "$REF"
  # Only fast-forward a branch; a detached tag/SHA has no upstream to pull.
  if git symbolic-ref -q HEAD >/dev/null; then
    git pull --ff-only origin "$REF"
  fi
fi
[ "$DRY_RUN" != "1" ] && info "now at: $(git rev-parse HEAD)  $(git log -1 --pretty=%s)"

# The revision just checked out may carry a NEWER version of this script,
# with steps this running copy knows nothing about — that is exactly the
# case when the seed step was added. The copy we are executing was taken
# BEFORE the checkout, so without this handover a deploy would forever
# run the previous release's deploy logic, one revision behind.
#
# Hand over once, and only once (DEPLOY_HANDOVER guards against a loop if
# the two versions somehow never compare equal). The backup is already
# taken, so the successor is told to skip it.
if [ "$DRY_RUN" != "1" ] && [ "${DEPLOY_HANDOVER:-0}" != "1" ] \
   && [ -f "$APP_DIR/scripts/deploy.sh" ] \
   && ! cmp -s "${DEPLOY_SELF_PATH:-$0}" "$APP_DIR/scripts/deploy.sh"; then
  info "deploy.sh differs in this revision — handing over to the checked-out version"
  handover_args=(--ref "$REF" --skip-backup)
  [ "$SKIP_BUILD" = "1" ] && handover_args+=(--skip-build)
  rm -f "${DEPLOY_SELF_PATH:-}"
  trap - EXIT
  DEPLOY_HANDOVER=1 DEPLOY_SELF_COPY= DEPLOY_SELF_PATH= \
    exec bash "$APP_DIR/scripts/deploy.sh" "${handover_args[@]}"
fi

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

  # Synthetic documents registering themselves as a production data source
  # are checked too — see scripts/check-seed-documents.mjs below, which
  # scopes the search to INSERT blocks. A plain grep cannot tell a seed
  # that REGISTERS a test fixture from one that DELETES it, and flagged
  # retire-cms-short-docs.sql for cleaning up exactly this kind of row.

  # No two seeds may register the same document under different ids. This
  # is what produced the duplicate source_document rows migration 0068
  # cleans up, and no database constraint can catch it: the real key is
  # (url, payer_id, content_hash), and the two offending seeds invented
  # DIFFERENT placeholder hashes for one document, satisfying it while
  # still describing that document twice.
  if command -v node >/dev/null 2>&1; then
    node scripts/check-seed-documents.mjs . || die "seed documents collide — see above; fix before deploying"
  else
    info "node not found — skipping seed-document collision check"
  fi

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
  #
  # Resolve the port AFTER the reload, so it reflects the process now
  # running rather than an assumption made at the top of the script.
  RESOLVED_PORT="$(detect_app_port)"
  LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:$RESOLVED_PORT}"
  info "app port: $RESOLVED_PORT"

  # --retry-connrefused rides out the reload window without a sleep.
  code="$(curl -s -o /dev/null -w '%{http_code}' \
          --retry 30 --retry-delay 2 --retry-connrefused --retry-all-errors \
          --max-time 180 "$LOCAL_URL/login" || echo 000)"
  if [ "$code" = "200" ]; then
    info "health check OK — $LOCAL_URL/login returned 200"
  else
    echo ""
    echo "HEALTH CHECK FAILED: $LOCAL_URL/login returned $code"
    echo "  Before rolling anything back, confirm this is not the check being"
    echo "  wrong: 'pm2 logs $PM2_APP --lines 40' prints the port Next bound to."
    echo "  If it differs from $RESOLVED_PORT, re-run with APP_PORT=<that port>."
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
