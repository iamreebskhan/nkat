# ============================================================================
# apply.ps1
# Applies all migrations + seed data to the local Postgres in docker-compose.
# Idempotent: safe to re-run.
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

Write-Host '== Applying seed data ==' -ForegroundColor Green
Get-ChildItem -Path 'db\seed' -Filter '*.sql' | Sort-Object Name | ForEach-Object {
  Run-Sql $_.FullName
}

Write-Host ''
Write-Host 'APPLY OK' -ForegroundColor Green
