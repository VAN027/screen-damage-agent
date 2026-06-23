@echo off
cd /d "%~dp0"

echo.
echo ========================================
echo   Screen Damage Agent - Tunnel
echo ========================================
echo.

REM Check if localtunnel is installed
if not exist "node_modules\localtunnel\" (
    echo [First run] Installing localtunnel...
    call npm install localtunnel
    echo.
)

echo Checking local service on port 8080...
powershell -Command "if (-not (Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue | Where-Object State -eq Listen)) { Write-Host '[WARN] Port 8080 is not listening! Start the services first (start.bat).' -ForegroundColor Yellow; timeout /t 5 }"

echo.
echo Starting tunnel...
node tunnel.cjs

pause
