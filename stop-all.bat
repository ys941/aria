@echo off
setlocal
title Aria - shutdown
cd /d "%~dp0"

echo ============================================================
echo                  STOPPING  ARIA
echo ============================================================
echo.

REM ---------- Aria app (whatever is listening on :7860) ----------
echo Stopping the Aria app (port 7860)...
set "KILLED="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7860" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
  set "KILLED=1"
)
taskkill /F /FI "WINDOWTITLE eq Aria App*" >nul 2>&1
if defined KILLED (echo       App stopped.) else (echo       App was not running.)

echo.
echo ============================================================
echo   Aria stopped.
echo   ^(The Modal Qwen voice GPU auto-sleeps after ~5 min idle,
echo    so nothing keeps billing once you're done.^)
echo ============================================================
echo.
pause
endlocal
