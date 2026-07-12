# US Gas Price Visualizer - one-command launcher (backend + frontend)
# Usage: run  .\dev.ps1  from the project root.
# Opens two windows: backend (auto data update + API) / frontend (Vite dev server)

$root = $PSScriptRoot

Write-Host "Starting backend window (port 8000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-File", "$root\backend\start.ps1"
)

Write-Host "Starting frontend window (port 5173)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command", "Set-Location '$root'; npm run dev"
)

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "Two windows launched:" -ForegroundColor Green
Write-Host "  backend   http://localhost:8000   (close window to stop)"
Write-Host "  frontend  http://localhost:5173"
Write-Host ""
Write-Host "This window can be closed." -ForegroundColor DarkGray