@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Screen Damage Detection Agent
cd /d "%~dp0"

echo ======================================
echo   Screen Damage Agent - Starting...
echo ======================================
echo.

:: Check node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo Install Node.js: https://nodejs.org/
    pause
    exit /b
)
echo [OK] Node.js found
node --version
echo.

:: Create logs dir
if not exist logs mkdir logs

:: LLM API Key
set LLM_API_KEY=sk-2A_vXV_IREK3BT3UtzGNYw

:: Kill leftover processes on target ports
echo Cleaning leftover processes...
for %%p in (8080 8081 8082 8083) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p " ^| findstr "LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
)

:: Start 4 services in background
echo.
echo Starting services...

start /B "" node services\knowledge-ai\src\index.mjs > logs\knowledge-ai.log 2>&1
echo   [8083] knowledge-ai

start /B "" node services\decision-engine\src\index.mjs > logs\decision-engine.log 2>&1
echo   [8081] decision-engine

start /B "" node services\decision-admin\src\index.mjs > logs\decision-admin.log 2>&1
echo   [8082] decision-admin

start /B "" node services\gateway-bff\src\index.mjs > logs\gateway-bff.log 2>&1
echo   [8080] gateway-bff

:: Wait for startup
echo.
echo Waiting for services (8s)...
timeout /t 8 /nobreak >nul

:: Verify all ports
echo.
echo Checking ports...
set ok=0
for %%p in (8080 8081 8082 8083) do (
    netstat -ano 2>nul | findstr ":%%p " | findstr "LISTENING" >nul
    if !errorlevel! equ 0 (
        echo   [OK] :%%p
    ) else (
        echo   [FAIL] :%%p - check logs\ folder
        set ok=1
    )
)

echo.
echo ======================================
if !ok! equ 0 (
    echo   All services running!
    echo.
    echo   App   : http://localhost:8080/
    echo   Admin : http://localhost:8082/admin
) else (
    echo   Some services failed to start.
    echo   Check logs\ folder for details.
)
echo ======================================
echo.
echo Press any key to open the app, or close this window to stop...
pause >nul
start http://localhost:8080/
