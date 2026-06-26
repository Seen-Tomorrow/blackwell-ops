@echo off
cd /d "%~dp0"
start "Vite Dev Server" npm run server
timeout /t 1 /nobreak >nul
npm run tauri
