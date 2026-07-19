@echo off
chcp 65001 >nul 2>&1
title sp-injector Launcher
setlocal
cd /d "%~dp0"

set PORT_PROXY=8080
set PORT_PANEL=8088

echo ============================================
echo   sp-injector Launcher
echo   dao fa zi ran
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Install Node.js first:
    echo   https://nodejs.org/
    pause
    exit /b 1
)

:: check if already running
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT_PROXY%/__health' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
    echo [sp-injector] already running
    echo   proxy : http://127.0.0.1:%PORT_PROXY%
    echo   panel : http://127.0.0.1:%PORT_PANEL%
    echo.
    echo opening panel...
    cmd /c start "" "http://127.0.0.1:%PORT_PANEL%"
    ping -n 3 127.0.0.1 >nul
    exit /b 0
)

:: start proxy in background
if not exist "state" mkdir "state"
echo [sp-injector] starting proxy...
start /b "" node proxy.js > "state\sp-injector.log" 2>&1

:: wait for port (max ~8s, ping -n N sleeps ~N-1 seconds)
set /a tries=0
:wait
ping -n 2 127.0.0.1 >nul
set /a tries+=1
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT_PROXY%/__health' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    if %tries% lss 6 goto :wait
    :: double check by netstat (some envs powershell rest is slow)
    netstat -ano | findstr ":%PORT_PROXY%.*LISTENING" >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] proxy start failed. See state\sp-injector.log
        pause
        exit /b 1
    )
)

:: record PID by port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT_PROXY%.*LISTENING"') do (
    echo %%a> "state\pid"
    goto :gotpid
)
:gotpid

echo.
echo [sp-injector] started
echo   proxy : http://127.0.0.1:%PORT_PROXY%   ^<- put this into ZCode API url
echo   panel : http://127.0.0.1:%PORT_PANEL%   ^<- open this in browser
echo   log   : state\sp-injector.log
echo.

echo opening panel...
cmd /c start "" "http://127.0.0.1:%PORT_PANEL%"

echo.
echo ============================================
echo  proxy running in background. you can close this window.
echo  to stop: double-click stop.cmd
echo ============================================
ping -n 4 127.0.0.1 >nul
endlocal
