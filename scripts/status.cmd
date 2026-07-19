@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0\.."

set PORT_PROXY=8080
set PORT_PANEL=8088

echo === sp-injector 状态 ===

:: 进程
if exist "state\pid" (
    set /p PID=<state\pid
    tasklist /FI "PID eq %PID%" 2>nul | find "node" >nul
    if errorlevel 1 (
        echo 进程: 未运行（PID 文件残留 %PID%）
    ) else (
        echo 进程: 运行中 PID=%PID%
    )
) else (
    echo 进程: 未运行
)

:: 健康检查
echo.
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT_PROXY%/__health' -TimeoutSec 3; Write-Host '代理: OK'; Write-Host ('  模板: ' + $r.template); Write-Host ('  模式: ' + $r.mode); Write-Host ('  注入: ' + $r.stats.injected + '/' + $r.stats.totalRequests) } catch { Write-Host '代理: 未响应' }"

echo.
echo 面板: http://127.0.0.1:%PORT_PANEL%
echo 代理: http://127.0.0.1:%PORT_PROXY%
endlocal
