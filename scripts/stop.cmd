@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0\.."

if not exist "state\pid" (
    echo [sp-injector] 未运行（无 PID 文件）
    exit /b 0
)
set /p PID=<state\pid
if "%PID%"=="" (
    echo [sp-injector] PID 文件为空
    del "state\pid" 2>nul
    exit /b 0
)

tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
if errorlevel 1 (
    echo [sp-injector] 进程 %PID% 已不存在
    del "state\pid" 2>nul
    exit /b 0
)

taskkill /PID %PID% /F >nul 2>&1
if errorlevel 1 (
    echo [sp-injector] 停止失败 PID=%PID%
    exit /b 1
)
del "state\pid" 2>nul
echo [sp-injector] 已停止 PID=%PID%
endlocal
