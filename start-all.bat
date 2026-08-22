@echo off
setlocal enabledelayedexpansion
title Aria - launcher
cd /d "%~dp0"

echo ============================================================
echo            STARTING  ARIA   -   pre-flight checks
echo ============================================================
echo.

REM ---------- pre-flight 1: .env exists ----------
if not exist ".env" (
  echo [X] .env is missing.
  echo     Copy .env.example to .env and fill in your brain + voice API keys
  echo     ^(GROQ_API_KEY is enough for both^), then run this again.
  echo.
  pause
  exit /b 1
)

REM ---------- pre-flight 2: a brain is configured (Groq is primary) ----------
set "BRAIN="
findstr /R /C:"^GROQ_API_KEY=." ".env" >nul && set "BRAIN=Groq"
if not defined BRAIN ( findstr /R /C:"^GEMINI_API_KEY=." ".env" >nul && set "BRAIN=Gemini" )
if not defined BRAIN ( findstr /R /C:"^XAI_API_KEY=." ".env" >nul && set "BRAIN=Grok" )
if not defined BRAIN ( findstr /R /C:"^MODAL_LLM_URL=https" ".env" >nul && set "BRAIN=Modal" )
if not defined BRAIN (
  echo [X] No brain configured. Set GROQ_API_KEY ^(or GEMINI_API_KEY / MODAL_LLM_URL^) in .env.
  echo.
  pause
  exit /b 1
)

REM ---------- pre-flight 3: a voice/TTS is configured ----------
set "VOICE="
findstr /R /C:"^MODAL_TTS_URL=https" ".env" >nul && set "VOICE=Qwen (Modal)"
if not defined VOICE ( findstr /R /C:"^GROQ_API_KEY=." ".env" >nul && set "VOICE=Orpheus (Groq)" )
if not defined VOICE (
  echo [X] No voice/TTS configured. Set MODAL_TTS_URL ^(or GROQ_API_KEY^) in .env.
  echo.
  pause
  exit /b 1
)
echo [ok] .env present  -  brain: !BRAIN!   voice: !VOICE!
echo      ^(Groq Orpheus TTS free tier is ~3,600 tokens/day; it auto-falls back to Modal Qwen.^)

REM ---------- pre-flight 4: nothing already on port 7860 ----------
netstat -ano | findstr ":7860" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [!] Something is already running on port 7860.
  echo     Run stop-all.bat first if Aria is misbehaving, then retry.
  echo     Opening the existing app in your browser...
  start "" http://localhost:7860
  echo.
  pause
  exit /b 0
)
echo.

echo ============================================================
echo                      LAUNCHING  ARIA
echo ============================================================
echo.
echo   Audio now streams over WebSocket on http://localhost:7860 -
echo   no Docker or LiveKit required.
echo.

REM ---------- start the Aria app ----------
echo Starting the Aria app on http://localhost:7860 ...
REM No /D switch: %~dp0 ends in a backslash, so /D "%~dp0" passes
REM "C:\...\ARIA\" where the \" reads as an escaped quote, and start fails with
REM "The filename, directory name, or volume label syntax is incorrect."
REM This script already did cd /d "%~dp0" at the top, so the spawned window
REM inherits the right folder. The command below is a quoted command STRING
REM (not a path), which start handles fine.
start "Aria App - close this window to stop the app" cmd /k "set GRADIO_SERVER_PORT=7860&& .venv\Scripts\python.exe app.py"

echo Waiting for the app to boot...
REM poll the port for up to ~30s, then open the browser
set "UP="
for /l %%i in (1,1,15) do (
  if not defined UP (
    timeout /t 2 >nul
    netstat -ano | findstr ":7860" | findstr "LISTENING" >nul && set "UP=1"
  )
)
if defined UP (
  echo App is up - opening the browser.
) else (
  echo App is still booting - opening the browser anyway ^(reload if needed^).
)
start "" http://localhost:7860

echo.
echo ============================================================
echo   Aria is running.
echo   - App window      : "Aria App" (live logs there)
echo   - Open in browser : http://localhost:7860
echo   - To shut down    : run stop-all.bat (or close the app window)
echo.
echo   The first spoken line takes ~30-60s while the Modal Qwen
echo   voice GPU cold-starts - the "sound booth" wait is normal.
echo ============================================================
echo.
pause
endlocal
