# PowerShell Startup Script for Astro-API
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Starting Astro-API Gateway (NASA / IPAC Bridge)         " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "[1/2] Installing requirements from requirements.txt..." -ForegroundColor Yellow
pip install -r requirements.txt

Write-Host "[2/2] Launching Uvicorn ASGI server on port 8000..." -ForegroundColor Green
uvicorn main:app --reload --port 8000 --host 0.0.0.0
