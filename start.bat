@echo off
cd /d "%~dp0"
title O-Steam-Idle
node -e "require.resolve('steam-user');require.resolve('steam-session');require.resolve('qrcode');require.resolve('cheerio')" >nul 2>&1
if errorlevel 1 (
  echo Installing/updating O-Steam-Idle dependencies...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
node app.js
if errorlevel 1 pause
