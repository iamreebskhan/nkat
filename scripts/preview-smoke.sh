#!/usr/bin/env bash
# Live smoke harness against http://localhost:3000.
# Walks the full mutation chain and reports any non-expected HTTP code.
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
EMAIL="admin@demo.local"
PASSWORD="PallioDemo2026!"
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE" /tmp/_pallio_resp.* 2>/dev/null' EXIT

pass=0; fail=0; failures=()

probe() {
  local name="$1" method="$2" path="$3" body="${4:-}" expect="${5:-^2}" outfile="${6:-}"
  local out=${outfile:-/tmp/_pallio_resp.$$}
  local args=(-s -b "$COOKIE" -c "$COOKIE" -X "$method" -o "$out" -w "%{http_code}")
  [ -n "$body" ] && args+=(-H "content-type: application/json" --data "$body")
  local code; code=$(curl "${args[@]}" "$BASE$path")
  local size; size=$(stat -c%s "$out" 2>/dev/null || echo 0)
  if [[ "$code" =~ $expect ]]; then
    pass=$((pass + 1))
    printf "  ✓ %-3s %-50s %s [%sb]\n" "$code" "$path" "$name" "$size"
  else
    fail=$((fail + 1))
    local excerpt; excerpt=$(head -c 240 "$out" 2>/dev/null | tr '\n' ' ')
    failures+=("$code $method $path -- $name -- $excerpt")
    printf "  ✗ %-3s %-50s %s\n       %s\n" "$code" "$path" "$name" "$excerpt"
  fi
}

extract_id() {
  grep -oE '"id":"[a-f0-9-]{36}"' "$1" | head -1 | sed 's/.*"\([a-f0-9-]\{36\}\)"/\1/'
}

echo "== logging in =="
LOGIN_CODE=$(curl -s -c "$COOKIE" -X POST "$BASE/api/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  -o /tmp/_pallio_resp.login -w "%{http_code}")
[ "$LOGIN_CODE" = "200" ] || { echo "FATAL: login $LOGIN_CODE"; cat /tmp/_pallio_resp.login; exit 1; }
echo "  cookie ok"
echo

echo "== Public UI pages =="
for p in /login /signup /forgot-password /reset-password /invites/abc; do
  probe "ui $p" GET "$p"
done

echo
echo "== Authenticated UI pages =="
for p in / /patients /patients/new /schedule /visits /billing/lookup \
         /billing/denials /billing/denials/log /billing/claims /billing/superbills \
         /payers /payers/attestations /payers/attestations/new \
         /reports /cheat-sheets /team /audit /onboarding \
         /admin/orgs /admin/compliance /admin/health /admin/settings \
         /care-plans /documents /inbox \
         /settings /settings/branding /settings/billing /settings/security /settings/rulebook
do
  probe "ui $p" GET "$p"
done

echo
echo "== Manifest href audit (every nav link in lib/manifests.ts) =="
manifest_hrefs=$(grep -oE 'href: "[^"]*"' lib/manifests.ts | sed 's/href: "//; s/"$//' | sort -u)
for href in $manifest_hrefs; do
  probe "manifest link $href" GET "$href"
done

echo
echo "== API GETs =="
probe "livez"               GET /api/health/livez
probe "patients list"       GET /api/patients
probe "visits list"         GET /api/visits
probe "denials list"        GET /api/denials
probe "billing payers"      GET /api/billing/payers
probe "attestations list"   GET /api/attestations
probe "attestation requests" GET /api/attestations/requests
probe "reports overview"    GET /api/reports/overview
probe "team invites list"   GET /api/team/invites
probe "team members list"   GET /api/team/members
probe "audit log"           GET /api/audit
probe "branding get"        GET /api/settings/branding
probe "license badge"       GET /api/settings/license
probe "subscription"        GET /api/billing/subscription "" "^(200|404)$"
probe "mfa status"          GET /api/auth/mfa/status
probe "admin orgs as org_admin" GET /api/admin/orgs "" "^(200|403)$"
probe "inbox"                   GET /api/inbox
probe "documents list"          GET /api/documents
probe "admin compliance"        GET /api/admin/compliance
probe "admin platform settings" GET /api/admin/platform-settings "" "^(200|403)$"
probe "superbills list"         GET /api/superbills

echo
echo "== Mutation chain: patient → visit → care plan → export =="
NEW_PATIENT='{"demographics":{"firstName":"Smoke","lastName":"Test","dateOfBirth":"1955-04-12","sexAssignedAtBirth":"F","addressLine1":"123 Oak St","city":"Cincinnati","state":"OH","zip":"45202"},"insurance":{},"clinical":{"primaryDiagnosisIcd10":"C50.911"},"consents":{"hipaaAcknowledged":true,"goalsOfCareConsent":true,"telehealthConsent":true},"careTeam":{}}'
probe "create patient"      POST /api/patients "$NEW_PATIENT" "^(200|201)$" /tmp/_pallio_resp.patient
PID=$(extract_id /tmp/_pallio_resp.patient)
echo "    patient_id=$PID"

[ -n "$PID" ] && probe "get patient"     GET "/api/patients/$PID"
[ -n "$PID" ] && probe "patch patient"   PATCH "/api/patients/$PID" '{"clinical":{"palliativeReferralReason":"smoke test"}}'
[ -n "$PID" ] && probe "care plan put"   PUT "/api/care-plans/$PID" '{"document":{"type":"doc","content":[]},"goalsOfCareSummary":"comfort focused"}'
[ -n "$PID" ] && probe "care plan get"   GET "/api/care-plans/$PID"

if [ -n "$PID" ]; then
  CLINICIAN_ID="c198e4d6-4d19-4331-9cdc-e7df0fda549e"
  VISIT='{"patientId":"'$PID'","clinicianUserId":"'$CLINICIAN_ID'","visitType":"established_patient_home","scheduledStart":"2026-05-15T14:00:00Z","isTelehealth":false}'
  probe "create visit"      POST /api/visits "$VISIT" "^(200|201)$" /tmp/_pallio_resp.visit
  VID=$(extract_id /tmp/_pallio_resp.visit)
  [ -n "$VID" ] && probe "get visit" GET "/api/visits/$VID"
fi

[ -n "$PID" ] && probe "patient export PDF" GET "/api/patients/$PID/export"

echo
echo "== Domain mutations (real heavy paths) =="

# Billing rule lookup (SQL-only path; AI keys not set in dev)
PAYER_ID=$(curl -s -b "$COOKIE" "$BASE/api/billing/payers" | grep -oE '"id":"[a-f0-9-]{36}"' | head -1 | sed 's/.*"\([a-f0-9-]\{36\}\)"/\1/')
if [ -n "$PAYER_ID" ]; then
  LOOKUP='{"payerId":"'$PAYER_ID'","state":"OH","cptCode":"99349","attribute":"covered"}'
  probe "billing lookup"     POST /api/billing/lookup "$LOOKUP" "^200$"
fi

# Log a denial against a non-existent superbill (expect 4xx)
DENIAL='{"superbillId":"00000000-0000-0000-0000-000000000000","carcCode":"50","cptCode":"99349","deniedAmountCents":5000,"deniedAt":"2026-05-09T00:00:00Z","decision":"pending","outcome":"pending"}'
probe "denial log no-superbill" POST /api/denials "$DENIAL" "^(404|422|500)$"

# Create attestation (real success)
if [ -n "$PAYER_ID" ]; then
  ATT='{"payerId":"'$PAYER_ID'","state":"OH","cptCode":"99349","attribute":"covered","coverageStatus":"covered","payerRepName":"Smoke Rep","callDate":"2026-05-09"}'
  probe "create attestation" POST /api/attestations "$ATT" "^(200|201)$" /tmp/_pallio_resp.att
fi

# Generate a cheat sheet PDF (Puppeteer locally)
probe "cheat sheet generate" POST /api/cheatsheets '{"orgName":"Demo Org","cptCodes":["99349"]}' "^200$"

# Team invite (Resend not configured → email-service dev fallback to stdout)
INVITE='{"email":"newhire+smoke@demo.local","roleTemplate":"clinician","permissions":["patients.list","patients.view","visits.view.own","visits.create","visits.edit"]}'
probe "team invite create" POST /api/team/invites "$INVITE" "^(200|201)$" /tmp/_pallio_resp.invite

# New endpoints added for wiring stubs to real backend
probe "inbox feed"          GET /api/inbox
probe "documents list"      GET /api/documents
probe "compliance probes"   GET /api/admin/compliance "" "^(200|403)$"
probe "platform settings"   GET /api/admin/platform-settings "" "^(200|403)$"
probe "superbills list"     GET /api/superbills

echo
echo "== Auth + profile =="
probe "mfa setup"           POST /api/auth/mfa/setup "" "^200$"
probe "mfa verify (bad)"    POST /api/auth/mfa/verify '{"code":"000000"}' "^422$"
probe "branding put"        PUT /api/settings/branding '{"primaryColor":"#0d9488"}' "^200$"
probe "forgot pwd"          POST /api/auth/password/request-reset '{"email":"nobody@example.com"}' "^200$"

echo
echo "== Negative paths =="
probe "cron without secret" POST /api/cron/payer-rule-alerts "" "^(401|503)$"
probe "checkout no keys"    POST /api/billing/checkout '{"tier":"team"}' "^(503|500)$"
probe "404 patient"         GET /api/patients/00000000-0000-0000-0000-000000000000 "" "^404$"
probe "bad body patient"    POST /api/patients '{"demographics":{}}' "^422$"

echo
echo "============================================"
echo " RESULT: $pass pass / $fail fail"
echo "============================================"
if [ "$fail" -gt 0 ]; then
  echo
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
