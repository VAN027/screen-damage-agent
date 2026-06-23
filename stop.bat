@echo off
title Screen Damage Agent - Stopping...
echo ======================================
echo   Stopping all services...
echo ======================================
echo.

for %%p in (8080 8081 8082 8083) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p " ^| findstr "LISTENING"') do (
        echo Killing port %%p (PID %%a)
        taskkill /F /PID %%a >nul 2>&1
    )
)

echo.
echo All services stopped.
pause
