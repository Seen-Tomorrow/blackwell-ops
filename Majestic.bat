@echo off
setlocal
cd /d "%~dp0"

title Majestic - Blackwell Ops Release

set "PY_CMD="
where py >nul 2>&1 && set "PY_CMD=py -3"
if not defined PY_CMD where python >nul 2>&1 && set "PY_CMD=python"

if not defined PY_CMD (
    echo.
    echo [majestic] Python not found. Install Python 3 and try again.
    pause
    exit /b 1
)

%PY_CMD% "%~dp0scripts\majestic\majestic_menu.py"
set "EXIT_CODE=%ERRORLEVEL%"

pause
exit /b %EXIT_CODE%