# ZTech Phase 1 — Windows development startup.
#
# Validates the prerequisites, then starts the SaaS API and the background
# worker as separate processes. Both use the least-privilege PostgreSQL roles
# (ztech_app for the API, ztech_worker for the worker); neither uses a
# superuser or the migrator credential.
#
# Usage (from the repository root, in PowerShell):
#   .\scripts\start-dev.ps1
#
# Prerequisites (see docs/PHASE-1-WINDOWS-STARTUP.md):
#   - Node.js >= 20.19 and npm
#   - PostgreSQL 16 reachable at ZTECH_PG_URL
#   - the role credentials in the environment (ZTECH_PG_PASSWORD_ZTECH_*)
#   - the database provisioned:  npm run db:dev:setup
#
# Stop both processes with Ctrl+C.

$ErrorActionPreference = 'Stop'

function Write-Step([string]$message) {
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

# 1. Node and npm.
Write-Step 'Validating Node.js and npm'
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not on PATH. Install Node.js >= 20.19 from https://nodejs.org' }
if (-not $npm) { Fail 'npm is not on PATH.' }
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { Fail 'node --version failed.' }
Write-Host "  node $nodeVersion"

# 2. PostgreSQL base URL.
Write-Step 'Validating PostgreSQL configuration'
if (-not $env:ZTECH_PG_URL) {
  Fail 'ZTECH_PG_URL is not set. Set it to the base PostgreSQL URL (e.g. postgres://postgres:postgres@localhost:5432/postgres).'
}
Write-Host "  ZTECH_PG_URL is set"

# 3. The runtime role credentials. The API needs ztech_app, ztech_identity and
#    ztech_control; the worker needs ztech_worker (and ztech_control to mint
#    its identity credential unless ZTECH_WORKER_IDENTITY_TOKEN is set).
$required = @(
  'ZTECH_PG_PASSWORD_ZTECH_APP',
  'ZTECH_PG_PASSWORD_ZTECH_IDENTITY',
  'ZTECH_PG_PASSWORD_ZTECH_CONTROL',
  'ZTECH_PG_PASSWORD_ZTECH_WORKER'
)
$missing = @($required | Where-Object { [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_)) })
if ($missing.Count -gt 0) {
  Fail "Missing role credential(s): $($missing -join ', '). Run npm run db:dev:setup first, or set them in the environment."
}
Write-Host '  role credentials are present'

# 4. The worker identity.
if (-not $env:ZTECH_WORKER_ID) {
  $env:ZTECH_WORKER_ID = 'ztech-dev-worker'
  Write-Host "  ZTECH_WORKER_ID defaulted to $env:ZTECH_WORKER_ID"
}

# 5. Start the API and the worker as separate processes.
Write-Step 'Starting the SaaS API (ztech_app)'
$api = Start-Process -FilePath 'node' -ArgumentList 'scripts/start-saas.js','--postgres' -PassThru -NoNewWindow
Write-Host "  API process id $($api.Id)"

Write-Step 'Starting the background worker (ztech_worker)'
$worker = Start-Process -FilePath 'node' -ArgumentList 'scripts/start-worker.js' -PassThru -NoNewWindow
Write-Host "  worker process id $($worker.Id)"

Write-Host ''
Write-Host 'Both processes are running. Press Ctrl+C to stop them.' -ForegroundColor Green

# Stop both on Ctrl+C.
$stopping = $false
function Stop-All {
  if ($stopping) { return }
  $stopping = $true
  Write-Host ''
  Write-Step 'Stopping the API and the worker'
  foreach ($p in @($api, $worker)) {
    if ($p -and -not $p.HasExited) {
      try { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue } catch {}
    }
  }
  Write-Host 'Stopped.' -ForegroundColor Green
}

try {
  # Wait until either process exits, or the user interrupts.
  while (-not $api.HasExited -and -not $worker.HasExited) {
    Start-Sleep -Seconds 1
  }
  if ($api.HasExited) { Write-Host "API exited with code $($api.ExitCode)" -ForegroundColor Yellow }
  if ($worker.HasExited) { Write-Host "Worker exited with code $($worker.ExitCode)" -ForegroundColor Yellow }
} finally {
  Stop-All
}
