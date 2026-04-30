@echo off
chdir /d "C:\Users\GHOST-TOWER\INFRA\blackwell-ops"
start "Vite Dev Server" npm run dev
timeout /t 1 /nobreak >nul
npm run tauri
