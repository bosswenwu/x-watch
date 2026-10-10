@echo off
cd /d "%~dp0"
node refresh.mjs
if errorlevel 1 (
  echo.
  echo 刷新没有拿到帖。
  pause
  exit /b 1
)
start "" "%~dp0index.html"
