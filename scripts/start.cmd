@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0\.."

:: 端口
set PORT_PROXY=8080
set PORT_PANEL=8088

:: 检查是否已在运行
if exist "state\pid" (
    set /p OLDPID=<state\pid
    tasklist /FI "PID eq %OLDPID%" 2>nul | find "%OLDPID%" >nul
    if not errorlevel 1 (
        echo [sp-injector] 已在运行 PID=%OLDPID%
        echo   面板: http://127.0.0.1:%PORT_PANEL%
        echo   代理: http://127.0.0.1:%PORT_PROXY%
        exit /b 0
    )
)

:: 启动（后台）
if not exist "state" mkdir "state"
echo [sp-injector] 启动中...
start /b "" node proxy.js > "state\sp-injector.log" 2>&1

:: 等待并取 PID
timeout /t 1 /nobreak >nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT_PROXY%.*LISTENING"') do (
    echo %%a> "state\pid"
    goto :gotpid
)
echo [sp-injector] 启动失败，未监听端口。查看 state\sp-injector.log
exit /b 1

:gotpid
set /p PID=<state\pid
echo [sp-injector] 已启动 PID=%PID%
echo   面板: http://127.0.0.1:%PORT_PANEL%
echo   代理: http://127.0.0.1:%PORT_PROXY%
echo   日志: state\sp-injector.log
endlocal
