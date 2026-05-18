#!/usr/bin/env bash
# ops-preflight.sh — one-shot production readiness audit.
#
# Run on the VPS:
#   sudo bash /opt/pallio/app/scripts/ops-preflight.sh
#
# Checks every operational gate before onboarding real users and
# prints a PASS/WARN/FAIL line per item. Exit 0 only if no FAILs.
# Read-only: changes nothing.

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/pallio/app}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BASE_URL="${BASE_URL:-https://app.pallio.io}"
PG_DB="${PG_DB:-pallio}"

pass=0; warn=0; fail=0
ok()   { echo "  ✅ PASS  $1"; pass=$((pass+1)); }
wn()   { echo "  ⚠️  WARN  $1"; warn=$((warn+1)); }
no()   { echo "  ❌ FAIL  $1"; fail=$((fail+1)); }

# Read a KEY from the env file without sourcing it (values may have spaces).
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"''; }

echo "Pallio ops preflight — $(date -u +%FT%TZ)"
echo "================================================"

echo "[1] App health"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/livez" || echo 000)
[ "$code" = "200" ] && ok "GET /api/health/livez → 200" || no "health check returned $code (app down?)"

echo "[2] Required runtime secrets ($ENV_FILE)"
[ -n "$(envval ANTHROPIC_API_KEY)" ] && ok "ANTHROPIC_API_KEY set (rule synthesis enabled)" \
  || no "ANTHROPIC_API_KEY missing — AI lookup/denial analysis disabled"
[ -n "$(envval OPENAI_API_KEY)" ] && ok "OPENAI_API_KEY set (vector/RAG embeddings enabled)" \
  || wn "OPENAI_API_KEY missing — RAG fallback inert (structured rules still work)"
[ -n "$(envval JWT_SECRET)" ] && ok "JWT_SECRET set" || no "JWT_SECRET missing — auth broken"
[ -n "$(envval DATABASE_URL)" ] && ok "DATABASE_URL set" || no "DATABASE_URL missing"
adb=$(envval ADMIN_DATABASE_URL)
[ -n "$adb" ] && ok "ADMIN_DATABASE_URL set (breakglass split client)" \
  || wn "ADMIN_DATABASE_URL missing — breakglass falls back to app role"

echo "[3] AMA CPT licence"
[ -n "$(envval AMA_LICENSE_TOKEN)" ] && ok "AMA_LICENSE_TOKEN set (full descriptors)" \
  || wn "AMA_LICENSE_TOKEN unset — CPT descriptors stay redacted (legal-safe default)"

echo "[4] Nightly backup cron"
if crontab -l 2>/dev/null | grep -q "nightly-backup.sh"; then
  ok "nightly-backup.sh scheduled in crontab"
elif sudo -u pallio crontab -l 2>/dev/null | grep -q "nightly-backup.sh"; then
  ok "nightly-backup.sh scheduled (pallio crontab)"
else
  no "nightly-backup.sh NOT in any crontab — no disaster recovery"
fi

echo "[5] RLS tenant isolation audit"
# Pure SQL — no Node/tsx (prod has no dev tooling). Every table with an
# org_id column MUST have row-level security enabled AND a policy.
RLS_SQL="
SELECT string_agg(c.relname, ', ')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
  AND EXISTS (SELECT 1 FROM information_schema.columns col
              WHERE col.table_schema='public' AND col.table_name=c.relname
                AND col.column_name='org_id')
  AND (c.relrowsecurity=false
       OR NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname='public' AND p.tablename=c.relname));
"
offenders=$(sudo -u postgres psql -tAc "$RLS_SQL" "$PG_DB" 2>/tmp/rls.out)
nt=$(sudo -u postgres psql -tAc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='org_id'" "$PG_DB" 2>/dev/null || echo "?")
if [ -s /tmp/rls.out ] && [ -z "$offenders" ]; then
  no "RLS query errored — see /tmp/rls.out"
elif [ -z "$offenders" ]; then
  ok "RLS: all $nt tenant tables have row-level security + policy"
else
  no "RLS: tables WITHOUT isolation → $offenders"
fi

echo "[6] Billing rule corpus"
rc=$(sudo -u postgres psql -tAc "SELECT COUNT(*) FROM payer_rule" "$PG_DB" 2>/dev/null || echo 0)
sc=$(sudo -u postgres psql -tAc "SELECT COUNT(*) FROM source_document" "$PG_DB" 2>/dev/null || echo 0)
if [ "${rc:-0}" -gt 0 ]; then ok "payer_rule has $rc rows, source_document $sc (lookups can cite)";
  else wn "payer_rule empty — every lookup returns 'unknown' until rules are loaded"; fi

echo "[7] pgvector extension"
hv=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_extension WHERE extname='vector'" "$PG_DB" 2>/dev/null || echo "")
[ "$hv" = "1" ] && ok "pgvector installed" || no "pgvector extension missing — vector search broken"

echo "================================================"
echo "RESULT: $pass pass · $warn warn · $fail fail"
if [ "$fail" -gt 0 ]; then
  echo "❌ Not ready — resolve FAILs before onboarding users."
  exit 1
fi
if [ "$warn" -gt 0 ]; then
  echo "⚠️  Usable, but review WARNs (RAG / AMA / backup may be partial)."
  exit 0
fi
echo "✅ All green — clear to onboard users."
