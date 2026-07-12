# US Gas Price backend launcher
# Usage: run  .\start.ps1  from the backend directory.
# Flow: activate venv -> incremental data update -> start API server

Set-Location $PSScriptRoot

Write-Host "[1/3] Activating venv..." -ForegroundColor Cyan
.\venv\Scripts\Activate.ps1

Write-Host "[2/3] Updating gas price data (incremental)..." -ForegroundColor Cyan
python ingest_eia.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "Update failed (network or key issue). Serving existing data." -ForegroundColor Yellow
}

Write-Host "[3/3] Starting API at http://localhost:8000 ..." -ForegroundColor Cyan
uvicorn main:app --port 8000