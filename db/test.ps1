# ============================================================================
# test.ps1
# Runs all SQL test files against the local Postgres.
# ============================================================================

param(
  [string]$Container = 'billing_rules_db',
  [string]$Db        = 'billing_rules',
  [string]$User      = 'admin'
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

function Run-Sql([string]$Path) {
  Write-Host ''
  Write-Host "== $($Path | Split-Path -Leaf) ==" -ForegroundColor Magenta
  Get-Content $Path -Raw | & docker exec -i $Container psql -U $User -d $Db -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "Test failed: $Path" }
}

Get-ChildItem -Path 'db\test' -Filter '*.sql' | Sort-Object Name | ForEach-Object {
  Run-Sql $_.FullName
}

Write-Host ''
Write-Host 'ALL TESTS OK' -ForegroundColor Green
