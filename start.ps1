# 屏损鉴定智能体 — 一键启动所有服务
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  屏损鉴定智能体 — 启动中..." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 先清理可能残留的进程
$ports = @(8080, 8081, 8082, 8083)
foreach ($port in $ports) {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Host "清理端口 $port (PID $($conn.OwningProcess))" -ForegroundColor Yellow
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# LLM API Key (从环境变量读取，部署时修改此处)
$env:LLM_API_KEY = "sk-2A_vXV_IREK3BT3UtzGNYw"

Write-Host ""

# 知识库 (8083)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; Write-Host '[knowledge-ai] 端口 8083' -ForegroundColor Green; node services/knowledge-ai/src/index.mjs"

# 管理中台 (8082)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; Write-Host '[decision-admin] 端口 8082' -ForegroundColor Green; node services/decision-admin/src/index.mjs"

# 决策引擎 (8081)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; Write-Host '[decision-engine] 端口 8081' -ForegroundColor Green; node services/decision-engine/src/index.mjs"

# BFF 网关 (8080)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; Write-Host '[gateway-bff] 端口 8080' -ForegroundColor Green; node services/gateway-bff/src/index.mjs"

Start-Sleep -Seconds 5

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  全部服务已启动" -ForegroundColor Green
Write-Host "  鉴定页面: http://localhost:8080/" -ForegroundColor White
Write-Host "  管理后台: http://localhost:8082/admin" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "关闭窗口即可停止所有服务" -ForegroundColor Gray
