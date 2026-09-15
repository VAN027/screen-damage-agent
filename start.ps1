Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  屏损鉴定智能体 — 启动中...' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan

function Require-EnvironmentVariable([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Name 未设置。请先设置独立的高强度随机值，再启动系统。"
    }
}

Require-EnvironmentVariable 'ADMIN_API_TOKEN'
Require-EnvironmentVariable 'INTERNAL_SERVICE_TOKEN'
if ([string]::IsNullOrWhiteSpace($env:LLM_API_KEY)) {
    Write-Host '[警告] LLM_API_KEY 未设置，大模型分析功能将不可用。' -ForegroundColor Yellow
} else {
    Write-Host '[OK] 已从环境变量读取 LLM_API_KEY。' -ForegroundColor Green
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '未找到 Node.js，请安装 Node.js 20 或更高版本。' }
$nodeMajor = [int]((& node -p 'process.versions.node.split(".")[0]').Trim())
if ($nodeMajor -lt 20) { throw 'Node.js 版本过低，请安装 Node.js 20 或更高版本。' }

$nodeDependency = Join-Path $root 'services\knowledge-ai\node_modules\better-sqlite3\package.json'
if (-not (Test-Path -LiteralPath $nodeDependency)) {
    Write-Host '[信息] 正在安装 Knowledge-AI Node.js 生产依赖...' -ForegroundColor Cyan
    & npm.cmd ci --omit=dev --no-audit --no-fund --prefix 'services\knowledge-ai'
    if ($LASTEXITCODE -ne 0) { throw 'Knowledge-AI Node.js 依赖安装失败。' }
}

$pythonExe = $null
$pythonArgs = @()
$venvCandidates = @(
    (Join-Path $root 'services\knowledge-ai\python\.venv\Scripts\python.exe'),
    (Join-Path $root 'services\knowledge-ai\python\venv\Scripts\python.exe')
)
foreach ($candidate in $venvCandidates) {
    if (Test-Path -LiteralPath $candidate) {
        $pythonExe = $candidate
        break
    }
}
if (-not $pythonExe) {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        $pythonExe = (& $py.Source -3 -c 'import sys; print(sys.executable)').Trim()
    }
}
if (-not $pythonExe) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) { $pythonExe = $python.Source }
}
if (-not $pythonExe) { throw '未找到 Python 3。' }

$pythonVersion = (& $pythonExe @pythonArgs -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")').Trim()
if ([version]$pythonVersion -lt [version]'3.10') { throw 'Python 版本过低，请安装 Python 3.10 或更高版本。' }

& $pythonExe @pythonArgs -c 'import fastapi, uvicorn, PIL, numpy, httpx, torch, transformers, cv2'
if ($LASTEXITCODE -ne 0) {
    throw 'Python 依赖不完整，请执行：python -m pip install -r services\knowledge-ai\python\requirements.txt'
}
$env:ORIENTATION_PYTHON = $pythonExe

$ports = @(8080, 8081, 8082, 8083, 8084)
$occupied = @()
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in @($connections)) {
        $occupied += "${port}(PID $($connection.OwningProcess))"
    }
}
if ($occupied.Count -gt 0) {
    throw "服务端口已被占用：$($occupied -join ', ')。请先停止对应进程；启动脚本不会强制终止其他程序。"
}

Start-Sleep -Seconds 1

$escapedRoot = $root.Replace("'", "''")
$escapedPython = $pythonExe.Replace("'", "''")
$pythonArgText = $pythonArgs -join ' '

function Start-ServiceWindow([string]$Name, [int]$Port, [string]$Command) {
    $windowCommand = "Set-Location -LiteralPath '$escapedRoot'; Write-Host '[$Name] 端口 $Port' -ForegroundColor Green; $Command"
    Start-Process powershell.exe -ArgumentList @('-NoExit', '-Command', $windowCommand) | Out-Null
}

Start-ServiceWindow 'python-features' 8084 "& '$escapedPython' $pythonArgText 'services/knowledge-ai/python/main.py'"
Start-Sleep -Seconds 2
Start-ServiceWindow 'knowledge-ai' 8083 "node 'services/knowledge-ai/src/index.mjs'"
Start-ServiceWindow 'decision-admin' 8082 "node 'services/decision-admin/src/index.mjs'"
Start-ServiceWindow 'decision-engine' 8081 "node 'services/decision-engine/src/index.mjs'"
Start-ServiceWindow 'gateway-bff' 8080 "node 'services/gateway-bff/src/index.mjs'"

Start-Sleep -Seconds 10

$failed = @()
foreach ($port in $ports) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Host "  [OK] :$port" -ForegroundColor Green
    } else {
        Write-Host "  [失败] :$port" -ForegroundColor Red
        $failed += $port
    }
}

if ($failed.Count -gt 0) {
    throw "以下服务未成功监听：$($failed -join ', ')"
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  全部服务已启动' -ForegroundColor Green
Write-Host '  鉴定页面: http://localhost:8080/' -ForegroundColor White
Write-Host '  管理后台: http://localhost:8082/admin' -ForegroundColor White
Write-Host '========================================' -ForegroundColor Cyan

Start-Process 'http://localhost:8080/'
