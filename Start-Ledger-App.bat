@echo off
title QuickBooks Personal Pro - Accounting Server
echo ===================================================
echo Starting QuickBooks Personal Pro Accounting Server...
echo ===================================================
cd /d "%~dp0"
if not exist "node_modules" (
    echo Installing dependencies for first-time run...
    call npm install
)
echo Opening http://localhost:3456 in your default browser...
start "" "http://localhost:3456"
node server.js
pause
