# ============================================================================
# apply.ps1
# Applies all migrations, then the seeds in db/seed/MANIFEST order, then
# db/test, to the local Postgres in docker-compose.
# NOT re-runnable on a database it has already built. 35 of the migrations
# create tables without IF NOT EXISTS, so a second run stops at the first of
# them (0002: relation "code" already exists) before any seed or test runs.
# To start again, use -Reset, which drops the volume first.
# Usage:
#   .\db\apply.ps1
#   .\db\apply.ps1 -Reset  # drops the volume and starts fresh
# ============================================================================

param(
  [switch]$Reset,
  [string]$Container = 'billing_rules_db',
  [string]$Db        = 'billing_rules',
  [string]$User      = 'admin'
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

function Wait-ForDb {
  for ($i = 0; $i -lt 60; $i++) {
    & docker exec $Container pg_isready -U $User -d $Db 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw 'Postgres did not become ready within 60 seconds.'
}

function Run-Sql([string]$Path) {
  Write-Host "  -> $Path" -ForegroundColor Cyan
  Get-Content $Path -Raw | & docker exec -i $Container psql -U $User -d $Db -v ON_ERROR_STOP=1 --quiet
  if ($LASTEXITCODE -ne 0) { throw "Failed: $Path" }
}

if ($Reset) {
  Write-Host '== Resetting database (dropping volume) ==' -ForegroundColor Yellow
  & docker compose down -v 2>&1 | Out-Null
}

Write-Host '== Starting Postgres container ==' -ForegroundColor Green
& docker compose up -d db 2>&1 | Out-Null

Write-Host '== Waiting for Postgres to be ready ==' -ForegroundColor Green
Wait-ForDb

Write-Host '== Applying migrations ==' -ForegroundColor Green
Get-ChildItem -Path 'db\migrations' -Filter '*.sql' | Sort-Object Name | ForEach-Object {
  Run-Sql $_.FullName
}

Write-Host '== Applying seed data (db\seed\MANIFEST order) ==' -ForegroundColor Green
# NOT Get-ChildItem | Sort-Object Name. That is ASCII order, where '-' (0x2D)
# sorts before '.' (0x2E), so payer-rules-denial-attributes-2.sql (round 2) ran
# BEFORE payer-rules-denial-attributes.sql (round 1). Rule seeds expire what
# they supersede and then revive their own rows with
# ON CONFLICT (id) DO UPDATE ... expiration_date = NULL, so whichever runs last
# wins: this script built a library with round 1 live on all 28 keys the two
# share, while production applies MANIFEST order through scripts/deploy.sh and
# served round 2 — the inversion round 1's own header records as a production
# incident (the older UnitedHealthcare Ohio rule, without the TIN edit, served
# with no error and correct row counts). Sorting also ran the ingestion seeds
# before payer-medicare.sql, leaving every Medicare ingestion source bound to
# no payer and inert. This is the same three-phase walk
# .github/workflows/ci.yml and docker-compose.yml do; keep the three in step.
$SeedDir  = Join-Path $Repo 'db\seed'
$Manifest = Get-Content (Join-Path $SeedDir 'MANIFEST') |
  ForEach-Object { ($_ -replace '#.*', '').Trim() } |
  Where-Object { $_ -ne '' }

# These fixtures sit beside MANIFEST and are deliberately not in it, so the
# deploy never applies them. A local database does, and WHERE matters:
#   * 0018 writes 15 payer_rule keys the rule library also writes. After the
#     library it leaves TWO live rules on each, and fetchPayerRule ends in
#     LIMIT 1, so the answer shown would depend on row order. It goes before.
#   * tenant-demo-palliative.sql prices its demo superbills by reading
#     payer_rule, so it goes after the library.
$FixturesBeforeRules = @(
  '0016_phase11_design_partner_subscription.sql',
  '0017_test_users.sql',
  '0018_test_palliative_payer_rules.sql',
  '0020_local_clinical_fixture.sql',
  'ingestion-source-medicare-pdf.sql'
)
$FixturesAfterRules = @('tenant-demo-palliative.sql')

$FixturesDone = $false
foreach ($Name in $Manifest) {
  if (-not $FixturesDone -and $Name -like 'payer-rules-*') {
    foreach ($Fixture in $FixturesBeforeRules) { Run-Sql (Join-Path $SeedDir $Fixture) }
    $FixturesDone = $true
  }
  Run-Sql (Join-Path $SeedDir $Name)
}
if (-not $FixturesDone) {
  throw 'db\seed\MANIFEST lists no payer-rules-* seed, so the local fixtures were never applied.'
}
foreach ($Fixture in $FixturesAfterRules) { Run-Sql (Join-Path $SeedDir $Fixture) }

# db/test is the part that can actually fail. Until 2026-09 this script ended
# at 'APPLY OK' and never ran it, so a local database built in the wrong seed
# order came up green and answered every lookup with the superseded rule.
# db/test/0002_rls_isolation.sql leaves two clearly-named fixture rows behind
# (org slugs 'acme' and 'beta', one client_company each); that is what
# db\test.ps1 has always done and re-running is safe.
Write-Host ''
Write-Host '== Running db\test ==' -ForegroundColor Green
& (Join-Path $PSScriptRoot 'test.ps1') -Container $Container -Db $Db -User $User

Write-Host ''
Write-Host 'APPLY OK' -ForegroundColor Green
