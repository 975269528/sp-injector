@echo off
chcp 65001 >nul 2>&1
title sp-injector Stopper
setlocal
cd /d "%~dp0"

echo ============================================
echo   sp-injector Stopper
echo ============================================
echo.

set PID=
if exist "state\pid" (
    set /p PID=<state\pid
) else (
    echo no pid file, finding by port...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080.*LISTENING"') do (
        set PID=%%a
    )
)

if "%PID%"=="" (
    echo [sp-injector] no running proxy detected
    ping -n 3 127.0.0.1 >nul
    exit /b 0
)

echo target PID=%PID%

:: use powershell Get-Process to check alive (robust across encodings)
powershell -NoProfile -Command "if (Get-Process -Id %PID% -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
    echo process %PID% not alive anymore
    if exist "state\pid" del "state\pid" 2>nul
    ping -n 3 127.0.0.1 >nul
    exit /b 0
)

echo stopping...
taskkill /PID %PID% /F >nul 2>&1
if errorlevel 1 (
    echo [ERROR] taskkill failed, trying Stop-Process...
    powershell -NoProfile -Command "try { Stop-Process -Id %PID% -Force } catch { exit 1 }"
)

:: verify stopped
ping -n 2 127.0.0.1 >nul
powershell -NoProfile -Command "if (Get-Process -Id %PID% -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
    echo [WARN] process still alive after kill
) else (
    if exist "state\pid" del "state\pid" 2>nul
    echo [sp-injector] stopped PID=%PID%
)

echo.
echo closing in 3s...
ping -n 4 127.0.0.1 >nul
endlocal
