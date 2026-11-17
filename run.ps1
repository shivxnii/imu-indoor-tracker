# Starts the IMU Indoor Tracker dev server (HTTPS) on Windows.
# Usage:  powershell -ExecutionPolicy Bypass -File .\run.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$front = Join-Path $root "frontend"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 18 or newer is required. Install it with:  winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
  Write-Host "Then close and reopen PowerShell and run this script again."
  exit 1
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Write-Host "Node.js $major found. Version 18 or newer is required." -ForegroundColor Red; exit 1 }

# Read PORT from .env if present
$port = 5173
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

Set-Location $front
if (-not (Test-Path (Join-Path $front "node_modules"))) {
  Write-Host "Installing dependencies (first run only)..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed." -ForegroundColor Red; exit 1 }
}

Write-Host ""
Write-Host "Open on this laptop:   https://localhost:$port" -ForegroundColor Green
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -ExpandProperty IPAddress
foreach ($ip in $ips) { Write-Host "Open on your phone:    https://${ip}:$port   (same Wi-Fi; accept the certificate warning)" -ForegroundColor Green }
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""
npm run dev
