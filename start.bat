@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Screen Damage Detection Agent
cd /d "%~dp0"

echo ======================================
echo   Screen Damage Agent - Starting...
echo ======================================
echo.

if not defined ADMIN_API_TOKEN (
    echo [ERROR] ADMIN_API_TOKEN is not set.
    echo Set it to a strong random value before starting the system.
    exit /b 1
)
if not defined INTERNAL_SERVICE_TOKEN (
    echo [ERROR] INTERNAL_SERVICE_TOKEN is not set.
    echo Set it to a different strong random value before starting the system.
    exit /b 1
)
if not defined LLM_API_KEY (
    echo [WARN] LLM_API_KEY is not set. LLM analysis will be unavailable.
) else (
    echo [OK] LLM_API_KEY loaded from the environment.
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install Node.js 20 or newer.
    exit /b 1
)
echo [OK] Node.js found
node --version
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if !NODE_MAJOR! lss 20 (
    echo [ERROR] Node.js 20 or newer is required.
    exit /b 1
)

if not exist "services\knowledge-ai\node_modules\better-sqlite3\package.json" (
    echo [INFO] Installing Knowledge-AI Node.js production dependencies...
    call npm ci --omit=dev --no-audit --no-fund --prefix services\knowledge-ai
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to install Knowledge-AI Node.js dependencies.
        exit /b 1
    )
)

set "PYTHON_EXE="
set "PYTHON_ARGS="
if exist "services\knowledge-ai\python\.venv\Scripts\python.exe" set "PYTHON_EXE=services\knowledge-ai\python\.venv\Scripts\python.exe"
if not defined PYTHON_EXE if exist "services\knowledge-ai\python\venv\Scripts\python.exe" set "PYTHON_EXE=services\knowledge-ai\python\venv\Scripts\python.exe"
if not defined PYTHON_EXE (
    where py >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%i in ('py -3 -c "import sys; print(sys.executable)"') do set "PYTHON_EXE=%%i"
    )
)
if not defined PYTHON_EXE (
    where python >nul 2>&1
    if !errorlevel! equ 0 set "PYTHON_EXE=python"
)
if not defined PYTHON_EXE (
    echo [ERROR] Python 3 not found.
    exit /b 1
)

"!PYTHON_EXE!" !PYTHON_ARGS! -c "import fastapi, uvicorn, PIL, numpy, httpx, torch, transformers, cv2" >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Python dependencies are incomplete.
    echo Run: "!PYTHON_EXE!" !PYTHON_ARGS! -m pip install -r services\knowledge-ai\python\requirements.txt
    exit /b 1
)
echo [OK] Python feature-service dependencies found
set "ORIENTATION_PYTHON=!PYTHON_EXE!"

if not exist logs mkdir logs

echo Checking service ports...
set "OCCUPIED_PORTS="
for %%p in (8080 8081 8082 8083 8084) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p " ^| findstr "LISTENING"') do (
        echo [ERROR] Port %%p is already used by PID %%a.
        set "OCCUPIED_PORTS=!OCCUPIED_PORTS! %%p"
    )
)
if defined OCCUPIED_PORTS (
    echo Stop the existing service or choose another port before starting.
    exit /b 1
)

echo.
echo Starting services...

start /B "" "!PYTHON_EXE!" !PYTHON_ARGS! services\knowledge-ai\python\main.py > logs\python-features.log 2>&1
echo   [8084] python-features

timeout /t 2 /nobreak >nul

start /B "" node services\knowledge-ai\src\index.mjs > logs\knowledge-ai.log 2>&1
echo   [8083] knowledge-ai

start /B "" node services\decision-admin\src\index.mjs > logs\decision-admin.log 2>&1
echo   [8082] decision-admin

start /B "" node services\decision-engine\src\index.mjs > logs\decision-engine.log 2>&1
echo   [8081] decision-engine

start /B "" node services\gateway-bff\src\index.mjs > logs\gateway-bff.log 2>&1
echo   [8080] gateway-bff

echo.
echo Waiting for services (12s)...
timeout /t 12 /nobreak >nul

echo.
echo Checking ports...
set "START_FAILED=0"
for %%p in (8080 8081 8082 8083 8084) do (
    netstat -ano 2>nul | findstr ":%%p " | findstr "LISTENING" >nul
    if !errorlevel! equ 0 (
        echo   [OK] :%%p
    ) else (
        echo   [FAIL] :%%p - check logs\ folder
        set "START_FAILED=1"
    )
)

echo.
echo ======================================
if "!START_FAILED!"=="0" (
    echo   All services running.
    echo   App   : http://localhost:8080/
    echo   Admin : http://localhost:8082/admin
) else (
    echo   Some services failed to start.
    echo   Check logs\ folder for details.
)
echo ======================================
echo.

if "!START_FAILED!"=="0" start "" http://localhost:8080/
exit /b !START_FAILED!
