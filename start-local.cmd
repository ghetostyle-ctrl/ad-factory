@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
if errorlevel 1 (
  echo.
  echo AD FACTORY could not start. Read the error above, then try again.
  pause
  exit /b 1
)
