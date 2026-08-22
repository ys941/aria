@echo off
REM Use this script's own folder so the launcher survives the project moving.
cd /d "%~dp0"
call npx vite --port 5174 --strictPort
